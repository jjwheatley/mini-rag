/** The local backends Mini-RAG can talk to. */
export type ProviderId = 'ollama' | 'llamacpp';

/**
 * Settings that belong to one backend. Held per provider so switching from Ollama to llama.cpp
 * and back does not lose either one's URL or model choice — the names are not interchangeable
 * (`llama3.1:8b` means nothing to llama-server) and neither are the ports.
 */
export interface ProviderConfig {
	url: string;
	/**
	 * Separate endpoint for embeddings. Empty means "use `url`". llama-server serves exactly one
	 * model per process, so a dedicated embedding model there requires a second instance.
	 */
	embeddingUrl: string;
	chatModel: string;
	embeddingModel: string;
	dedicatedEmbeddingEnabled: boolean;
}

export interface PluginSettings {
	/** Bumped when the persisted shape changes; drives migration on load. */
	settingsVersion: number;
	provider: ProviderId;
	providers: Record<ProviderId, ProviderConfig>;

	// Provider-independent below this line.
	ragTopK: number;
	temperature: number;
	isContextFreeChatsEnabled: boolean;
	embeddingCacheEnabled: boolean;
	lastContextPath: string | null;
	lastContextType: 'file' | 'folder' | null;
}

/** The pre-2.3 flat shape, kept for the migration to read. */
export interface LegacyPluginSettings {
	aiModel?: unknown;
	embeddingModel?: unknown;
	dedicatedEmbeddingEnabled?: unknown;
	ollamaURL?: unknown;
	ragTopK?: unknown;
	temperature?: unknown;
	isContextFreeChatsEnabled?: unknown;
	embeddingCacheEnabled?: unknown;
	lastContextPath?: unknown;
	lastContextType?: unknown;
}

export type MessageRoles = 'user' | 'assistant';

export interface Message {
	role: MessageRoles
	content: string;
	timestamp: string;
}
