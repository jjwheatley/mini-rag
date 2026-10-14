import {defaultSettings, PROVIDER_IDS} from "../defaults";
import {ProviderId} from "../types";
import {LlamaCppProvider} from "./llamacpp-provider";
import {OllamaProvider} from "./ollama-provider";
import {AiProvider, ProviderRuntime} from "./types";

/**
 * Synchronous on purpose: loadAI() is called synchronously from onload and from MenuManager, so an
 * async factory would ripple into all three call sites. A future in-process provider does its
 * model loading lazily in ready() instead.
 *
 * An unrecognised provider id falls back to Ollama rather than throwing — a bad value in
 * data.json should not stop the plugin from loading.
 */
export function createProvider(runtime: ProviderRuntime): AiProvider {
	switch (runtime.settings.provider) {
		case 'llamacpp':
			return new LlamaCppProvider(runtime);
		case 'ollama':
		default:
			return new OllamaProvider(runtime);
	}
}

export interface ProviderSummary {
	id: ProviderId;
	displayName: string;
}

/**
 * Every provider, in dropdown order, named by its own capabilities — so the settings dropdown
 * cannot drift from what the providers call themselves. Constructing one makes no requests.
 */
export function listProviders(): ProviderSummary[] {
	return PROVIDER_IDS.map(id => {
		const settings = defaultSettings();
		settings.provider = id;
		return {id, displayName: createProvider({settings}).capabilities.displayName};
	});
}
