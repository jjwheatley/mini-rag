import {requestUrl} from "obsidian";
import MiniRagPlugin from "../../main";
import {OLLAMA_API} from "../constants";
import {formatOllamaError, withRetry} from "../utils";

interface OllamaGenerateChunk {
	response?: string;
	done?: boolean;
	context?: number[];
	error?: string;
}

export interface SendQuestionOptions {
	/** Called with each token and the full text accumulated so far. */
	onToken?: (token: string, fullText: string) => void;
	/** When false, waits for the full response (used for hidden context priming). */
	stream?: boolean;
}

export class OllamaWrapper {
	plugin: MiniRagPlugin;
	private context: number[] = [];
	// Allows ChatWindow.onClose() to cancel an in-flight fetch, when the panel is closed mid-response.
	private abortController: AbortController | null = null;

	abort() {
		this.abortController?.abort();
		this.abortController = null;
	}

	clearContext() {
		this.context = [];
	}

	constructor(plugin: MiniRagPlugin) {
		this.plugin = plugin;
	}

	get resolvedEmbeddingModel(): string {
		if (this.plugin.settings.dedicatedEmbeddingEnabled && this.plugin.settings.embeddingModel) {
			return this.plugin.settings.embeddingModel;
		}
		return this.plugin.settings.aiModel;
	}

	// Polls /api/ps until the embedding model runner has fully unloaded.
	// keep_alive:0 only schedules the unload — the runner may still hold pinned host
	// memory for a moment after the embed call returns, which causes CUDA init to fail
	// when the chat model runner starts immediately after.
	// Returns false if the model was still loaded when the timeout expired.
	async waitForEmbeddingModelUnloaded(timeoutMs = 10000): Promise<boolean> {
		const model = this.resolvedEmbeddingModel;
		if (!model) return true;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!(await this.isModelLoaded(model))) return true;
			await new Promise(resolve => setTimeout(resolve, 300));
		}
		return false;
	}

	private async isModelLoaded(model: string): Promise<boolean> {
		try {
			const result = await requestUrl({
				method: 'GET',
				url: `${this.plugin.settings.ollamaURL}${OLLAMA_API.ps}`,
			});
			const loaded = (result.json.models ?? []) as {name?: string; model?: string}[];
			return loaded.some(m => {
				const psName = m.name ?? m.model ?? '';
				return psName === model || psName.startsWith(model + ':');
			});
		} catch {
			return false;
		}
	}

	async getEmbedding(text: string): Promise<number[]> {
		return (await this.getEmbeddings([text]))[0];
	}

	async getEmbeddings(texts: string[]): Promise<number[][]> {
		return withRetry(async () => {
			const result = await requestUrl({
				method: "POST",
				url: `${this.plugin.settings.ollamaURL}${OLLAMA_API.embed}`,
				body: JSON.stringify({
					model: this.resolvedEmbeddingModel,
					input: texts,
					keep_alive: 0,
					// Force CPU so the embedding runner never competes with the chat model for VRAM.
					options: {num_gpu: 0},
				}),
			});
			if (result.json.error) {
				throw new Error(formatOllamaError(String(result.json.error)));
			}
			return result.json.embeddings as number[][];
		});
	}

	async getModelList(): Promise<string[]> {
		return withRetry(async () => {
			const result = await requestUrl({
				method: "GET",
				url: `${this.plugin.settings.ollamaURL}${OLLAMA_API.tags}`,
			});
			const output = (result.json.models ?? []).map((model: { name: string }) => model.name) as string[];
			output.sort((a, b) => a.localeCompare(b));
			return output;
		});
	}

	async sendQuestion(question: string, options: SendQuestionOptions = {}): Promise<string> {
		// On retry, a streaming request restarts from scratch; any partial response is discarded by the caller.
		// shouldAbort: if abort() was called during the retry sleep, abortController is null — skip the retry.
		return withRetry(
			() => {
				if (options.stream === false) {
					return this.sendQuestionBuffered(question);
				}
				return this.sendQuestionStreaming(question, options.onToken);
			},
			2,
			1000,
			() => this.abortController === null && options.stream !== false,
		);
	}

	private buildGenerateBody(question: string, stream: boolean) {
		return {
			prompt: question,
			context: this.context,
			model: this.plugin.settings.aiModel,
			options: {
				temperature: this.plugin.settings.temperature,
			},
			stream,
		};
	}

	private getGenerateUrl(): string {
		return `${this.plugin.settings.ollamaURL}${OLLAMA_API.generate}`;
	}

	private async sendQuestionBuffered(question: string): Promise<string> {
		const result = await requestUrl({
			method: "POST",
			url: this.getGenerateUrl(),
			body: JSON.stringify(this.buildGenerateBody(question, false)),
		});

		if (result.json.error) {
			throw new Error(formatOllamaError(String(result.json.error)));
		}

		const output = result.json.response ?? "";
		if (result.json.context) {
			this.context = result.json.context;
		}
		return output;
	}

	private async sendQuestionStreaming(
		question: string,
		onToken?: (token: string, fullText: string) => void,
	): Promise<string> {
		// fetch (rather than Obsidian's requestUrl) is used here because requestUrl buffers the
		// whole response and can't stream. This is safe: the plugin is desktop-only and talks to
		// a localhost Ollama instance, so there's no CORS concern.
		// Create a new abort controller per request; cleared when the stream finishes or abort() is called.
		this.abortController = new AbortController();
		const response = await fetch(this.getGenerateUrl(), {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(this.buildGenerateBody(question, true)),
			signal: this.abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(formatOllamaError(
				`Ollama request failed (${response.status})${detail ? `: ${detail}` : ""}`,
			));
		}

		if (!response.body) {
			throw new Error("Ollama returned an empty response body.");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let fullText = "";

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			let chunk: OllamaGenerateChunk;
			try {
				chunk = JSON.parse(trimmed) as OllamaGenerateChunk;
			} catch {
				throw new Error(`Ollama returned an unexpected response: ${trimmed.slice(0, 120)}`);
			}
			if (chunk.error) {
				throw new Error(formatOllamaError(chunk.error));
			}
			if (chunk.response) {
				fullText += chunk.response;
				onToken?.(chunk.response, fullText);
			}
			if (chunk.done && chunk.context) {
				this.context = chunk.context;
			}
		};

		let readResult = await reader.read();
		while (!readResult.done) {
			buffer += decoder.decode(readResult.value, {stream: true});
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
			readResult = await reader.read();
		}

		// Flush any data not followed by a newline (Ollama always terminates lines,
		// but flush defensively in case the stream ends without one).
		if (buffer.trim()) processLine(buffer);

		this.abortController = null;
		return fullText;
	}
}
