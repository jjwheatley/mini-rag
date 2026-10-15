import {BaseHttpProvider} from "./base-http-provider";
import {EmbeddingsUnsupportedError, ModelNotAvailableError, ProviderError} from "./errors";
import {extractErrorText, getJson, parseSseLine, postJson, streamLines} from "./http";
import {ChatMessage, ChatRequestOptions} from "./types";

const OPENAI_API = {
	chat: "/v1/chat/completions",
	embeddings: "/v1/embeddings",
	models: "/v1/models",
} as const;

/** One streamed chat-completion event. */
interface ChatCompletionChunk {
	choices?: {delta?: {content?: string | null}}[];
	error?: unknown;
	/** The closing chunk, when asked for with stream_options.include_usage. */
	usage?: {prompt_tokens?: number};
	/** llama-server's own report, on its last chunk. */
	timings?: {prompt_n?: number};
}

interface EmbeddingDatum {
	index?: number;
	embedding: number[] | number[][];
}

/**
 * How backends say "this model cannot embed". The phrasing and the status both vary — llama-server
 * without --embeddings, llama-server with --pooling none, another server given a chat model — and the
 * V1 raw-context fallback depends on recognising every one, so this is matched on text as well.
 */
const EMBEDDINGS_UNSUPPORTED = [
	/does not support embeddings?/i,
	/embeddings? (is|are) not supported/i,
	/not an embedding model/i,
	/pooling type '?none'?/i,
];

/** Failures that come from the GPU runtime rather than from the request itself. */
const GPU_FAILURE = /cuda|vulkan|metal|out of (device )?memory|outofdevicememory|failed to allocate|insufficient memory|\bgpu\b/i;

/**
 * A client error fails the same way every time — an over-long context, an unknown model — so
 * retrying only delays the message. Timeouts and rate limits are the exceptions: they clear up.
 */
function isPermanentStatus(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Averages per-token vectors into one sentence embedding. */
function meanPool(vectors: number[][]): number[] {
	return vectors[0]
		.map((_, dim) => vectors.reduce((total, vector) => total + vector[dim], 0))
		.map(total => total / vectors.length);
}

/**
 * llama-server started with --pooling none returns a vector per token instead of one per input.
 * Mean-pooling recovers a usable embedding rather than failing the whole index build.
 */
function toSentenceEmbedding(embedding: number[] | number[][]): number[] {
	return Array.isArray(embedding[0]) ? meanPool(embedding as number[][]) : (embedding as number[]);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The OpenAI wire format, shared by every backend that speaks it — llama-server today, and LM
 * Studio, vLLM, Jan or KoboldCpp for free later. Subclasses add only their identity, model listing
 * quirks and setup hints.
 */
export abstract class OpenAiCompatibleProvider extends BaseHttpProvider {
	// --- Chat ----------------------------------------------------------------------------------

	protected async streamChat(
		messages: ChatMessage[],
		signal: AbortSignal,
		{onToken, maxTokens, onUsage}: ChatRequestOptions = {},
	): Promise<string> {
		let fullText = '';
		let finished = false;

		await streamLines(
			`${this.baseUrl}${OPENAI_API.chat}`,
			{
				model: this.chatModel,
				messages,
				// Temperature sits at the top level here, unlike Ollama's `options` object.
				temperature: this.temperature,
				stream: true,
				// The prompt's token count, which sizes the parts of a staged summary.
				stream_options: {include_usage: true},
				...(maxTokens ? {max_tokens: maxTokens} : {}),
			},
			signal,
			line => {
				if (finished) return;
				const frame = parseSseLine(line);
				if (frame === null) return;
				if (frame === 'done') {
					finished = true;
					return;
				}

				let chunk: ChatCompletionChunk;
				try {
					chunk = JSON.parse(frame.payload) as ChatCompletionChunk;
				} catch {
					throw new ProviderError(
						`The server returned an unexpected response: ${frame.payload.slice(0, 120)}`,
					);
				}
				if (chunk.error) {
					const detail = extractErrorText(chunk, '');
					throw new ProviderError(detail, {detail});
				}

				const promptTokens = chunk.usage?.prompt_tokens ?? chunk.timings?.prompt_n;
				if (typeof promptTokens === 'number') onUsage?.({promptTokens});

				// The opening chunk carries only the role, and some servers end with a usage-only
				// chunk that has no choices; neither has text.
				const token = chunk.choices?.[0]?.delta?.content;
				if (token) {
					fullText += token;
					onToken?.(token, fullText);
				}
			},
			(status, body) => this.requestError(status, body),
		);

		return fullText;
	}

	// --- Embeddings ----------------------------------------------------------------------------

	protected async embedBatch(texts: string[]): Promise<number[][]> {
		const result = await postJson<{error?: unknown; data?: EmbeddingDatum[]}>({
			url: `${this.embeddingEndpoint}${OPENAI_API.embeddings}`,
			body: {model: this.resolvedEmbeddingModel, input: texts},
		});

		if (result.status >= 400 || result.json?.error) {
			throw this.classifyEmbedError(result.status, result.json, result.text);
		}

		const data = result.json?.data ?? [];
		// The index builder assigns vectors to chunks by position, so a short response would slide
		// every later chunk onto its neighbour's vector without any error.
		if (data.length !== texts.length) {
			throw new ProviderError(
				`The server returned ${data.length} embeddings for ${texts.length} inputs.`,
				{permanent: true},
			);
		}

		// Servers are not required to answer in request order; `index` is the only reliable key.
		const ordered = data.every(datum => typeof datum.index === 'number')
			? [...data].sort((a, b) => (a.index as number) - (b.index as number))
			: data;
		return ordered.map(datum => toSentenceEmbedding(datum.embedding));
	}

	protected classifyEmbedError(status: number, json: unknown, text: string): ProviderError {
		const detail = extractErrorText(json, text);
		const model = this.resolvedEmbeddingModel;

		if (status === 501 || EMBEDDINGS_UNSUPPORTED.some(pattern => pattern.test(detail))) {
			return new EmbeddingsUnsupportedError(model, this.id, detail);
		}
		if (status === 404) {
			return new ModelNotAvailableError(model, detail);
		}
		return this.requestError(status, text, json);
	}

	// --- Model listing -------------------------------------------------------------------------

	async getModelList(): Promise<string[]> {
		return this.listModelsAt(this.baseUrl);
	}

	/** The models a server at `base` reports. Separate from getModelList for second servers. */
	protected async listModelsAt(base: string): Promise<string[]> {
		return this.retryListing(async () => {
			const result = await getJson<{data?: {id: string}[]}>({url: `${base}${OPENAI_API.models}`});
			if (result.status >= 400) {
				throw this.requestError(result.status, result.text, result.json);
			}
			const ids = (result.json?.data ?? []).map(model => model.id);
			return ids.sort((a, b) => a.localeCompare(b));
		});
	}

	// --- Errors --------------------------------------------------------------------------------

	/**
	 * GPU trouble is the commonest local-server failure, and the fix is a setting the user controls
	 * — but a different one on each backend, so each names its own. Abstract so a new backend has
	 * to decide what to say rather than silently inheriting someone else's advice.
	 */
	protected abstract gpuTroubleshooting(): {server: string; tips: string[]};

	formatError(error: unknown): string {
		const detail = super.formatError(error);
		if (!GPU_FAILURE.test(detail)) return detail;

		const {server, tips} = this.gpuTroubleshooting();
		return [
			`${server} could not run the model on your GPU.`,
			'',
			`This comes from ${server} on your machine, not from Mini-RAG. Try:`,
			...tips.map(tip => `• ${tip}`),
			'',
			`Details: ${detail}`,
		].join('\n');
	}

	/** An HTTP failure, carrying the server's own message as `detail` for display. */
	protected requestError(status: number, bodyText: string, json: unknown = parseJson(bodyText)): ProviderError {
		const detail = extractErrorText(json, bodyText);
		return new ProviderError(
			`${this.capabilities.displayName} request failed (${status})${detail ? `: ${detail}` : ''}`,
			{status, detail: detail || undefined, permanent: isPermanentStatus(status)},
		);
	}
}
