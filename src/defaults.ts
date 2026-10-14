import {PluginSettings, ProviderConfig, ProviderId} from "./types";

/** Bump alongside a change to the persisted settings shape, and add a migration step. */
export const SETTINGS_VERSION = 2;

export const PROVIDER_IDS: readonly ProviderId[] = ['ollama', 'llamacpp'] as const;

/**
 * Frozen so an accidental shallow merge cannot write through to them. The old
 * `Object.assign({}, DEFAULT_SETTINGS, data)` was a shallow copy, which with a nested `providers`
 * object would have let the live settings share — and then mutate — these defaults, silently
 * changing the placeholder text the settings tab reads from here.
 */
export const DEFAULT_PROVIDER_CONFIGS: Readonly<Record<ProviderId, ProviderConfig>> = Object.freeze({
	ollama: Object.freeze({
		url: 'http://localhost:11434',
		embeddingUrl: '',
		chatModel: '',
		embeddingModel: '',
		dedicatedEmbeddingEnabled: false,
	}),
	llamacpp: Object.freeze({
		url: 'http://localhost:8080',
		// llama-server runs one model per process, so the embedding model is always a second one.
		embeddingUrl: 'http://localhost:8081',
		chatModel: '',
		embeddingModel: '',
		dedicatedEmbeddingEnabled: false,
	}),
}) as Readonly<Record<ProviderId, ProviderConfig>>;

export function defaultProviderConfig(provider: ProviderId): ProviderConfig {
	return {...DEFAULT_PROVIDER_CONFIGS[provider]};
}

export function defaultProviderConfigs(): Record<ProviderId, ProviderConfig> {
	return {
		ollama: defaultProviderConfig('ollama'),
		llamacpp: defaultProviderConfig('llamacpp'),
	};
}

/** A fresh deep copy every call — never hand a shared object to live settings. */
export function defaultSettings(): PluginSettings {
	return {
		settingsVersion: SETTINGS_VERSION,
		provider: 'ollama',
		providers: defaultProviderConfigs(),
		ragTopK: 3,
		temperature: 0.1,
		isContextFreeChatsEnabled: false,
		embeddingCacheEnabled: false,
		lastContextPath: null,
		lastContextType: null,
	};
}

/** Read-only reference for placeholders and defaults in the settings UI. */
export const DEFAULT_SETTINGS: PluginSettings = defaultSettings();
