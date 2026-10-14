// Pure accessors over PluginSettings. No Obsidian imports, so they are usable from anywhere.

import {defaultProviderConfig} from "./defaults";
import {PluginSettings, ProviderConfig, ProviderId} from "./types";

/** Removes trailing slashes so `${url}${path}` never produces a doubled separator. */
export function trimSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

export function activeProviderId(settings: PluginSettings): ProviderId {
	return settings.provider;
}

/** The active backend's config, falling back to defaults if the entry is somehow absent. */
export function activeProviderConfig(settings: PluginSettings): ProviderConfig {
	return settings.providers[settings.provider] ?? defaultProviderConfig(settings.provider);
}

/**
 * The endpoint embeddings should go to. The embedding URL is where the dedicated model runs, so it
 * applies only while that model is in use; otherwise the chat model embeds, on the main server.
 */
export function embeddingEndpoint(config: ProviderConfig): string {
	const dedicatedUrl = config.dedicatedEmbeddingEnabled ? config.embeddingUrl : '';
	return trimSlash(dedicatedUrl || config.url);
}

/** The chat endpoint base. */
export function chatEndpoint(config: ProviderConfig): string {
	return trimSlash(config.url);
}
