import {OLLAMA_API} from "../constants";
import {firstToUpper} from "../utils";
import {BaseHttpProvider} from "./base-http-provider";
import {
	EmbeddingsUnsupportedError,
	ModelNotAvailableError,
	ProviderError,
} from "./errors";
import {extractErrorText, getJson, postJson, streamLines} from "./http";
import {ChatMessage, ChatRequestOptions, ModelInstallHint, ProviderCapabilities, ProviderId} from "./types";

/** One NDJSON line from /api/chat. */
interface OllamaChatChunk {
	message?: {role?: string; content?: string};
	done?: boolean;
	error?: string;
	/** On the final chunk: how many tokens the prompt came to. */
	prompt_eval_count?: number;
}

/** Ollama-registry embedding models worth suggesting. */
const CURATED_EMBEDDING_MODELS = [
	'all-minilm',
	'bge-m3',
	'mxbai-embed-large',
	'nomic-embed-text',
	'snowflake-arctic-embed',
];

/** Ollama ids are "name:tag"; the tag is presentation, not identity. */
const modelBase = (name: string) => name.split(':')[0];

export class OllamaProvider extends BaseHttpProvider {
	readonly id: ProviderId = 'ollama';

	readonly capabilities: ProviderCapabilities = {
		displayName: 'Ollama',
		embeddings: true,
		dedicatedEmbeddingModel: true,
		separateEmbeddingEndpoint: false,
		modelListing: true,
		embeddingModelSelection: 'curated',
		modelUnloadPolling: true,
		modelIdsHaveTags: true,
		modelFixedByServer: false,
	};

	// --- Embeddings ----------------------------------------------------------------------------

	protected async embedBatch(texts: string[], isLastBatch: boolean): Promise<number[][]> {
		const dedicated = this.config.dedicatedEmbeddingEnabled;
		const result = await postJson<{error?: unknown; embeddings: number[][]}>({
			url: `${this.embeddingEndpoint}${OLLAMA_API.embed}`,
			body: {
				model: this.resolvedEmbeddingModel,
				input: texts,
				// With a dedicated embedding model, keep it resident between batches and release it
				// only after the last, so one index build pays one model load instead of one per
				// batch. When the chat model doubles as the embedding model these must be omitted
				// entirely — it is already loaded, and keep_alive:0 would unload it mid-chat.
				...(dedicated && {keep_alive: isLastBatch ? 0 : '5m'}),
			},
		});

		if (result.status >= 400 || result.json?.error) {
			throw this.classifyEmbedError(result.status, result.json, result.text);
		}
		return result.json.embeddings;
	}

	/**
	 * Deliberately matches on text as well as status. Ollama has shipped both 501 and 400 for a
	 * model that cannot embed, depending on version, so a status-only check would silently break
	 * the V1 fallback. The string matching is confined here and unit-tested, rather than spread
	 * across three call sites as it once was.
	 */
	private classifyEmbedError(status: number, json: unknown, text: string): ProviderError {
		const detail = extractErrorText(json, text);
		const model = this.resolvedEmbeddingModel;

		if (status === 501 || /does not support (embeddings?|generate)/i.test(detail)
			|| /embedding.*not supported/i.test(detail)) {
			return new EmbeddingsUnsupportedError(model, this.id, detail);
		}
		if (status === 404 || /not found/i.test(detail)) {
			return new ModelNotAvailableError(model, detail);
		}
		return new ProviderError(this.formatError(detail), {status, detail});
	}

	// --- Model listing and VRAM ----------------------------------------------------------------

	async getModelList(): Promise<string[]> {
		return this.retryListing(async () => {
			const result = await getJson<{models?: {name: string}[]}>({url: `${this.baseUrl}${OLLAMA_API.tags}`});
			if (result.status >= 400) {
				throw new ProviderError(`Ollama request failed (${result.status})`, {status: result.status});
			}
			const models = (result.json?.models ?? []).map(model => model.name);
			models.sort((a, b) => a.localeCompare(b));
			return models;
		});
	}

	/**
	 * keep_alive:0 only schedules the unload — the runner can still hold pinned host memory for a
	 * moment after the embed call returns, which makes CUDA init fail when the chat model's runner
	 * starts immediately afterwards. Returns false if it was still loaded at the deadline.
	 */
	async waitForEmbeddingModelUnloaded(timeoutMs = 10000): Promise<boolean> {
		const model = this.resolvedEmbeddingModel;
		if (!model) return true;

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!(await this.isModelLoaded(model))) return true;
			await new Promise(resolve => window.setTimeout(resolve, 300));
		}
		return false;
	}

	private async isModelLoaded(model: string): Promise<boolean> {
		try {
			const result = await getJson<{models?: {name?: string; model?: string}[]}>({url: `${this.baseUrl}${OLLAMA_API.ps}`});
			const loaded = result.json?.models ?? [];
			return loaded.some(entry => {
				const name = entry.name ?? entry.model ?? '';
				return name === model || name.startsWith(model + ':');
			});
		} catch {
			return false;
		}
	}

	// --- Chat ----------------------------------------------------------------------------------

	/**
	 * /api/chat rather than /api/generate: the conversation travels as a message list, which is
	 * the shape every other backend uses too, instead of Ollama's opaque replayed token array.
	 */
	protected async streamChat(
		messages: ChatMessage[],
		signal: AbortSignal,
		{onToken, maxTokens, onUsage}: ChatRequestOptions = {},
	): Promise<string> {
		let fullText = '';

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			let chunk: OllamaChatChunk;
			try {
				chunk = JSON.parse(trimmed) as OllamaChatChunk;
			} catch {
				throw new ProviderError(
					`Ollama returned an unexpected response: ${trimmed.slice(0, 120)}`,
				);
			}
			if (chunk.error) {
				throw new ProviderError(this.formatError(chunk.error), {detail: chunk.error});
			}
			const token = chunk.message?.content;
			if (token) {
				fullText += token;
				onToken?.(token, fullText);
			}
			if (typeof chunk.prompt_eval_count === 'number') onUsage?.({promptTokens: chunk.prompt_eval_count});
		};

		await streamLines(
			`${this.baseUrl}${OLLAMA_API.chat}`,
			{
				model: this.chatModel,
				messages,
				options: {temperature: this.temperature, ...(maxTokens ? {num_predict: maxTokens} : {})},
				stream: true,
			},
			signal,
			processLine,
			(status, body) => new ProviderError(
				`Ollama request failed (${status})${body ? `: ${body}` : ''}`,
				{status, detail: body || undefined},
			),
		);

		return fullText;
	}

	// --- Presentation --------------------------------------------------------------------------

	curatedEmbeddingModels(): string[] {
		return [...CURATED_EMBEDDING_MODELS];
	}

	isSameModel(a: string, b: string): boolean {
		return modelBase(a) === modelBase(b);
	}

	displayModelName(id: string): string {
		if (!id) return id;
		return firstToUpper(modelBase(id));
	}

	embeddingInstallHint(model: string): ModelInstallHint {
		// There is nothing to pull until a model is chosen.
		if (!model) return {summary: 'Choose an embedding model above.', command: null};
		return {
			summary: `Mini-RAG expected to find "${model}" in Ollama.`,
			command: `ollama pull ${model}`,
		};
	}

	/** Ollama's runner failures are mostly GPU problems, and the advice is Ollama-specific. */
	formatError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const detail = extractOllamaErrorDetail(message);

		if (/cuda|gpu|vulkan|shared object initialization/i.test(detail)) {
			return [
				"Ollama could not run the model on your GPU (CUDA error).",
				"",
				"This comes from Ollama on your machine, not from Mini-RAG. Try:",
				"• Quit and restart the Ollama app",
				"• Update your GPU drivers",
				"• Force CPU mode: set OLLAMA_NO_GPU=1, then restart Ollama",
				"• Choose a smaller model in Mini-RAG settings",
				"",
				`Details: ${detail}`,
			].join("\n");
		}

		return detail !== message ? detail : message;
	}
}

function extractOllamaErrorDetail(message: string): string {
	const jsonMatch = message.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as {error?: string};
			if (parsed.error) {
				return parsed.error;
			}
		} catch {
			// Not JSON — use the raw message below.
		}
	}

	return message.replace(/^Ollama request failed \(\d+\):\s*/i, "").trim() || message;
}
