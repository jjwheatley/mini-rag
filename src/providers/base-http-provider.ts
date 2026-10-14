import {withRetry} from "../utils";
import {activeProviderConfig, chatEndpoint, embeddingEndpoint} from "../settings";
import {ProviderConfig} from "../types";
import {EmbeddingsUnsupportedError, ProviderError, ProviderUnreachableError} from "./errors";
import {
	AiProvider,
	ChatMessage,
	ChatRequestOptions,
	ModelInstallHint,
	ProviderCapabilities,
	ProviderId,
	ProviderRuntime,
	RetryPolicy,
	SendQuestionOptions,
} from "./types";

/**
 * Shared plumbing for every HTTP-backed provider: config access, abort handling, retry policy and
 * embedding batching. Subclasses supply only the wire format.
 *
 * Nothing in AiProvider itself mentions HTTP, so a future in-process provider implements that
 * interface directly rather than extending this.
 */
export abstract class BaseHttpProvider implements AiProvider {
	abstract readonly id: ProviderId;
	abstract readonly capabilities: ProviderCapabilities;

	protected abortController: AbortController | null = null;
	protected retryPolicy: RetryPolicy = {retries: 2, delayMs: 1000};

	/** Completed exchanges, oldest first, always as user/assistant pairs. */
	protected history: ChatMessage[] = [];

	/**
	 * The most conversation, in characters, sent with a question. Every turn carries a RAG block,
	 * so untrimmed history outgrows the model's context within a few questions, and the server
	 * then truncates silently — usually the oldest content, which is the grounding. ~12k
	 * characters is roughly 3k tokens, leaving room for the answer in a 4k context window.
	 */
	protected maxHistoryChars = 12000;

	constructor(protected readonly runtime: ProviderRuntime) {}

	/** Read fresh every call, so a settings change takes effect on the next request. */
	protected get config(): ProviderConfig {
		return activeProviderConfig(this.runtime.settings);
	}

	protected get baseUrl(): string {
		return chatEndpoint(this.config);
	}

	get embeddingEndpoint(): string {
		return embeddingEndpoint(this.config);
	}

	protected get chatModel(): string {
		return this.config.chatModel;
	}

	protected get temperature(): number {
		return this.runtime.settings.temperature;
	}

	get resolvedEmbeddingModel(): string {
		const config = this.config;
		if (config.dedicatedEmbeddingEnabled && config.embeddingModel) {
			return config.embeddingModel;
		}
		return config.chatModel;
	}

	abort(): void {
		this.abortController?.abort();
		this.abortController = null;
	}

	clearContext(): void {
		this.history = [];
	}

	/** Only Ollama pins VRAM this way; everyone else has nothing to wait for. */
	async waitForEmbeddingModelUnloaded(_timeoutMs = 10000): Promise<boolean> {
		return true;
	}

	async getEmbedding(text: string): Promise<number[]> {
		return (await this.getEmbeddings([text]))[0];
	}

	async getEmbeddings(texts: string[], batchSize = 32): Promise<number[][]> {
		if (!this.capabilities.embeddings) {
			throw new EmbeddingsUnsupportedError(this.resolvedEmbeddingModel, this.id);
		}

		const results: number[][] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);
			const isLastBatch = i + batchSize >= texts.length;
			results.push(...await this.retry(() => this.embedBatch(batch, isLastBatch)));
		}
		return results;
	}

	async sendQuestion(question: string, options: SendQuestionOptions = {}): Promise<string> {
		// The turn is built once, outside the retry, and committed to history only after an
		// answer arrives. Pushing inside the attempt would store the question once per retry, and
		// a failed or aborted turn would leave half an exchange behind.
		const outgoing: ChatMessage[] = [...this.history, {role: 'user', content: question}];

		// Per-turn context rides in a system message ahead of the conversation. It is rebuilt
		// every turn and never enters history, so earlier turns' excerpts do not accumulate.
		const context = options.context || undefined;
		const conversation = this.trimHistory(outgoing, context?.length ?? 0, options.budgetChars);
		const messages: ChatMessage[] = context
			? [{role: 'system', content: context}, ...conversation]
			: conversation;

		const answer = await this.streamWithRetry(messages, {onToken: options.onToken});
		this.history = [...outgoing, {role: 'assistant', content: answer}];
		return answer;
	}

	async complete(prompt: string, options: ChatRequestOptions = {}): Promise<string> {
		return this.streamWithRetry([{role: 'user', content: prompt}], options);
	}

	remember(question: string, answer: string): void {
		this.history = [...this.history, {role: 'user', content: question}, {role: 'assistant', content: answer}];
	}

	/**
	 * Streams one chat request, retrying failures, under a controller abort() can cancel.
	 *
	 * The controller is owned here rather than by each subclass. It is what abort() cancels, and
	 * its being null is how the retry learns that a cancel arrived — leaving that to subclass
	 * discipline meant a provider that forgot silently got no retries at all.
	 *
	 * It is deliberately NOT cleared on failure: a failed attempt leaves it set so the retry
	 * proceeds, while abort() clears it so the retry is skipped.
	 */
	private async streamWithRetry(messages: ChatMessage[], options: ChatRequestOptions): Promise<string> {
		return this.retry(
			async () => {
				this.abortController = new AbortController();
				const result = await this.streamChat(
					// Copies, so a provider cannot mutate what is remembered.
					messages.map(message => ({...message})),
					this.abortController.signal,
					options,
				);
				this.abortController = null;
				return result;
			},
			() => this.abortController === null,
		);
	}

	/**
	 * Fits the conversation to maxHistoryChars. The current question is always sent, however long.
	 * Earlier exchanges are added newest first, whole pairs only, and the walk stops at the first
	 * pair that does not fit rather than reaching past it for an older, smaller one — a gap would
	 * leave the model reading replies to questions it never saw. Stored history is untouched.
	 *
	 * `reservedChars` is room already spoken for — the per-turn context — which, like the current
	 * question, is always sent and so comes out of the budget first.
	 */
	protected trimHistory(messages: ChatMessage[], reservedChars = 0, budgetChars = this.maxHistoryChars): ChatMessage[] {
		const current = messages[messages.length - 1];
		const earlier = messages.slice(0, -1);
		let remaining = budgetChars - reservedChars - current.content.length;
		let start = earlier.length;

		for (let end = earlier.length; end >= 2; end -= 2) {
			const size = earlier[end - 2].content.length + earlier[end - 1].content.length;
			if (size > remaining) break;
			remaining -= size;
			start = end - 2;
		}
		return [...earlier.slice(start), current];
	}

	/**
	 * Retries per the provider's policy, but never past an error the provider marked permanent.
	 * That flag is the general form of the old `/status 501/` check: a capability failure cannot
	 * be fixed by asking again.
	 */
	protected retry<T>(fn: () => Promise<T>, extraAbort?: (lastError: unknown) => boolean): Promise<T> {
		let lastError: unknown;
		return withRetry(
			async () => {
				try {
					return await fn();
				} catch (error) {
					lastError = error;
					throw error;
				}
			},
			this.retryPolicy.retries,
			this.retryPolicy.delayMs,
			() => (lastError instanceof ProviderError && lastError.permanent) || (extraAbort?.(lastError) ?? false),
		);
	}

	/**
	 * A retry for listing models, which gives up at once when nothing is listening. A refused
	 * connection fails the same way every time — and on Windows takes about two seconds to do so —
	 * so retrying only keeps the settings tab waiting, where the user has a refresh button anyway.
	 * A server that answers with an error, say while a model loads, is still retried.
	 */
	protected retryListing<T>(fn: () => Promise<T>): Promise<T> {
		return this.retry(fn, lastError => lastError instanceof ProviderUnreachableError);
	}

	// --- Defaults a subclass may override -----------------------------------------------------

	curatedEmbeddingModels(): string[] {
		return [];
	}

	/** Exact match by default. Ollama overrides to ignore the ":tag" suffix. */
	isSameModel(a: string, b: string): boolean {
		return a === b;
	}

	displayModelName(id: string): string {
		return id;
	}

	formatError(error: unknown): string {
		if (error instanceof ProviderError) {
			return error.detail ?? error.message;
		}
		return error instanceof Error ? error.message : String(error);
	}

	// --- Subclass contract ---------------------------------------------------------------------

	protected abstract embedBatch(texts: string[], isLastBatch: boolean): Promise<number[][]>;

	/**
	 * Streams one answer to the given conversation, whose last message is the user's question.
	 * History, trimming and the abort signal are all handled by sendQuestion.
	 */
	protected abstract streamChat(
		messages: ChatMessage[],
		signal: AbortSignal,
		options: ChatRequestOptions,
	): Promise<string>;

	abstract getModelList(): Promise<string[]>;

	abstract embeddingInstallHint(model: string): ModelInstallHint;
}
