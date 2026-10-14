import {PluginSettings, ProviderId} from "../types";

export type {ProviderId};

/** One turn of a conversation, as every OpenAI-compatible backend expects it. */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface SendQuestionOptions {
	/** Called with each token and the full text accumulated so far. */
	onToken?: (token: string, fullText: string) => void;
	/**
	 * Material for this turn only — retrieved excerpts, or the whole raw context. Sent as a
	 * leading system message and never stored, so each turn's excerpts replace the last's rather
	 * than piling up in history.
	 */
	context?: string;
	/**
	 * The most characters the whole request may carry — context, conversation and question — as
	 * the chat model's window allows. The conversation is trimmed to fit. Without it, a fixed
	 * allowance applies.
	 */
	budgetChars?: number;
}

/** What a single chat request can ask of the backend, beyond the messages. */
export interface ChatRequestOptions {
	onToken?: (token: string, fullText: string) => void;
	/** Stops the answer at this many tokens. */
	maxTokens?: number;
	/** Told how many tokens the server counted in the prompt, when it says. */
	onUsage?: (usage: {promptTokens: number}) => void;
}

/** How the settings tab should offer an embedding model for a given backend. */
export type EmbeddingModelSelection =
	/**
	 * A hand-picked list, matched against what is installed (Ollama) or what the embedding server
	 * runs (llama.cpp).
	 */
	'curated';

/**
 * What a backend can do. The settings UI branches on these rather than on the provider id, so
 * adding a backend does not mean hunting down `if (provider === 'ollama')` checks.
 */
export interface ProviderCapabilities {
	displayName: string;
	/** False means getEmbeddings throws without issuing a request. */
	embeddings: boolean;
	/** Whether a second, embedding-only model can be chosen at all. */
	dedicatedEmbeddingModel: boolean;
	/** llama-server serves one model per process, so embeddings need their own URL. */
	separateEmbeddingEndpoint: boolean;
	/** Whether the chat model can be picked from a list rather than typed. */
	modelListing: boolean;
	embeddingModelSelection: EmbeddingModelSelection;
	/** The Ollama-only VRAM unload dance. */
	modelUnloadPolling: boolean;
	/** Ollama ids carry a ":tag" suffix; other backends' ids do not. */
	modelIdsHaveTags: boolean;
	/**
	 * The server runs the model it was started with, whatever a request names (llama.cpp), so the
	 * running model is the one in use. Ollama loads whichever model is asked for.
	 */
	modelFixedByServer: boolean;
}

/** Guidance shown when the chosen embedding model is not available. */
/**
 * How to get a model running. The chat panel and the settings tab build their steps around it, so
 * every provider's hint reads the same way.
 */
export interface ModelInstallHint {
	/** What Mini-RAG expected and did not find, as a sentence; or, for a chat model, how to load one. */
	summary: string;
	/** The command that sets it up, or null when there is nothing to run. */
	command: string | null;
	/** How to run the command, where that matters: llama-server keeps running, so in its own terminal. */
	commandNote?: string;
}

export interface RetryPolicy {
	retries: number;
	delayMs: number;
}

/**
 * Everything a provider needs from the plugin. Narrow on purpose: a provider can be constructed
 * in a test from a plain object, with no Plugin, App or vault.
 */
export interface ProviderRuntime {
	settings: PluginSettings;
}

export interface AiProvider {
	readonly id: ProviderId;
	readonly capabilities: ProviderCapabilities;
	/** The embedding model actually in use: the dedicated one when set, else the chat model. */
	readonly resolvedEmbeddingModel: string;
	/** The base URL embeddings go to. Part of the cache key, so same-named models cannot collide. */
	readonly embeddingEndpoint: string;

	abort(): void;
	clearContext(): void;
	getEmbedding(text: string): Promise<number[]>;
	getEmbeddings(texts: string[], batchSize?: number): Promise<number[][]>;
	getModelList(): Promise<string[]>;
	sendQuestion(question: string, options?: SendQuestionOptions): Promise<string>;
	/**
	 * A request outside the conversation: the prompt alone, neither sent with the chat so far nor
	 * remembered in it. Retried and abortable like a question.
	 */
	complete(prompt: string, options?: ChatRequestOptions): Promise<string>;
	/** Adds an exchange to the conversation without sending anything. */
	remember(question: string, answer: string): void;
	/** True once the embedding model has released its VRAM. A no-op outside Ollama. */
	waitForEmbeddingModelUnloaded(timeoutMs?: number): Promise<boolean>;

	/** Setup guidance for a missing embedding model — replaces hardcoded `ollama pull`. */
	embeddingInstallHint(model: string): ModelInstallHint;
	/**
	 * How to make another chat model available, for a server that cannot simply list more (llama.cpp
	 * runs one per process). Absent where the model list already shows everything installed.
	 */
	chatModelInstallHint?(): ModelInstallHint;
	/**
	 * Asks the servers which models they are running, where that decides the model in use rather
	 * than the one chosen (`modelFixedByServer`). Never throws: a server that is down is simply
	 * not known about.
	 */
	identifyRunningModels?(): Promise<void>;
	/** The chat model the server is running, where that is the model in use; null if unknown. */
	readonly runningChatModel?: string | null;
	/** Suggested embedding models, when `embeddingModelSelection` is 'curated'. */
	curatedEmbeddingModels(): string[];
	/**
	 * Embedding models the server itself reports, where it can name them apart from its chat models
	 * (llama.cpp's second server). The curated list is matched against these instead.
	 */
	listEmbeddingModels?(): Promise<string[]>;
	/**
	 * How many tokens the chat model accepts, when the server can say; null when it cannot. Never
	 * throws: it is a best-effort lookup, and without it requests are sent whole, as before.
	 * Absent for servers that trim an over-long prompt themselves (Ollama).
	 */
	contextLength?(): Promise<number | null>;
	/** Ollama treats "nomic-embed-text" and "nomic-embed-text:latest" as the same model. */
	isSameModel(a: string, b: string): boolean;
	/** A short name for headers and saved-chat filenames. */
	displayModelName(id: string): string;
	/** Turns a backend's errors into guidance — replaces formatOllamaError. */
	formatError(error: unknown): string;

	/**
	 * Optional lifecycle, for a future in-process provider that must load a model before use and
	 * free it on unload. HTTP providers leave both undefined.
	 */
	ready?(): Promise<void>;
	dispose?(): Promise<void>;
}

/**
 * The slice of a provider that index building needs. Narrowing buildIndex to this means its tests
 * need a four-property fake rather than a whole provider.
 */
export type EmbeddingSource = Pick<
	AiProvider,
	'id' | 'resolvedEmbeddingModel' | 'embeddingEndpoint' | 'getEmbeddings' | 'identifyRunningModels'
>;
