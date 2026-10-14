// Migration of persisted settings (data.json). Pure — no Obsidian imports — because this is the
// one piece of the plugin that can destroy a user's configuration, so it must be fully testable.

import {
	defaultProviderConfig,
	defaultSettings,
	PROVIDER_IDS,
	SETTINGS_VERSION,
} from "./defaults";
import {PluginSettings, ProviderConfig, ProviderId} from "./types";

export interface MigrationResult {
	settings: PluginSettings;
	/** True when the on-disk shape changed and should be rewritten. */
	migrated: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/** Matches the top-K slider: integers 1-10. */
function asTopK(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(10, Math.max(1, Math.round(value)));
}

function isProviderId(value: unknown): value is ProviderId {
	return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * `replayContextInit` needs both the path and the type, so a half-set pair is dead weight that
 * can only confuse later reads. Normalise it to null here.
 */
function readLastContext(raw: Record<string, unknown>): Pick<PluginSettings, 'lastContextPath' | 'lastContextType'> {
	const path = raw.lastContextPath;
	const type = raw.lastContextType;
	const validPath = typeof path === 'string' && path.length > 0 ? path : null;
	const validType = type === 'file' || type === 'folder' ? type : null;
	if (validPath === null || validType === null) return {lastContextPath: null, lastContextType: null};
	return {lastContextPath: validPath, lastContextType: validType};
}

/** Copies the settings that are shared across providers, validating each. */
function readSharedSettings(raw: Record<string, unknown>): Omit<PluginSettings, 'settingsVersion' | 'provider' | 'providers'> {
	const defaults = defaultSettings();
	return {
		ragTopK: asTopK(raw.ragTopK, defaults.ragTopK),
		temperature: clampNumber(raw.temperature, 0.1, 1.0, defaults.temperature),
		isContextFreeChatsEnabled: asBoolean(raw.isContextFreeChatsEnabled, defaults.isContextFreeChatsEnabled),
		embeddingCacheEnabled: asBoolean(raw.embeddingCacheEnabled, defaults.embeddingCacheEnabled),
		...readLastContext(raw),
	};
}

/** Merges a stored provider config over the defaults. Reports whether anything was missing. */
function readProviderConfig(
	provider: ProviderId,
	stored: unknown,
): {config: ProviderConfig; complete: boolean} {
	const config = defaultProviderConfig(provider);
	if (!isPlainObject(stored)) return {config, complete: false};

	let complete = true;
	const keys: (keyof ProviderConfig)[] = [
		'url', 'embeddingUrl', 'chatModel', 'embeddingModel', 'dedicatedEmbeddingEnabled',
	];
	for (const key of keys) {
		if (!(key in stored)) {
			complete = false;
			continue;
		}
		if (key === 'dedicatedEmbeddingEnabled') {
			config.dedicatedEmbeddingEnabled = asBoolean(stored[key], config.dedicatedEmbeddingEnabled);
		} else if ((key === 'url' || key === 'embeddingUrl') && config[key] && !asString(stored[key], '').trim()) {
			// A blank address where there is a default reads as that default — it is what the
			// field shows as its placeholder, so a saved blank would look set while being empty.
			complete = false;
		} else {
			config[key] = asString(stored[key], config[key]);
		}
	}
	return {config, complete};
}

/** True when the data looks like the pre-2.3 flat shape rather than a versioned one. */
function isLegacyShape(raw: Record<string, unknown>): boolean {
	if (typeof raw.settingsVersion === 'number') return false;
	return ['ollamaURL', 'aiModel', 'embeddingModel', 'dedicatedEmbeddingEnabled'].some(key => key in raw);
}

/** Folds the flat Ollama-only settings into the ollama provider entry. */
function migrateFromLegacy(raw: Record<string, unknown>): PluginSettings {
	const ollama = defaultProviderConfig('ollama');
	ollama.url = asString(raw.ollamaURL, '').trim() || ollama.url;
	ollama.chatModel = asString(raw.aiModel, ollama.chatModel);
	ollama.embeddingModel = asString(raw.embeddingModel, ollama.embeddingModel);
	ollama.dedicatedEmbeddingEnabled = asBoolean(
		raw.dedicatedEmbeddingEnabled,
		ollama.dedicatedEmbeddingEnabled,
	);

	return {
		settingsVersion: SETTINGS_VERSION,
		provider: 'ollama',
		providers: {
			ollama,
			llamacpp: defaultProviderConfig('llamacpp'),
		},
		...readSharedSettings(raw),
	};
}

/**
 * Normalises whatever `loadData()` returned into current-shape settings.
 *
 * `migrated` is true only when the file should be rewritten. It stays false for a fresh install
 * (nothing to preserve, so don't create a file the user never asked for) and for settings written
 * by a *newer* version of the plugin — rewriting those would discard configuration this build
 * does not understand.
 */
export function migrateSettings(raw: unknown): MigrationResult {
	if (!isPlainObject(raw)) {
		return {settings: defaultSettings(), migrated: false};
	}

	if (isLegacyShape(raw)) {
		return {settings: migrateFromLegacy(raw), migrated: true};
	}

	const storedVersion = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0;
	const storedProviders = isPlainObject(raw.providers) ? raw.providers : {};

	const providers = {} as Record<ProviderId, ProviderConfig>;
	let allComplete = isPlainObject(raw.providers);
	for (const provider of PROVIDER_IDS) {
		const {config, complete} = readProviderConfig(provider, storedProviders[provider]);
		providers[provider] = config;
		if (!complete) allComplete = false;
	}

	const settings: PluginSettings = {
		settingsVersion: SETTINGS_VERSION,
		provider: isProviderId(raw.provider) ? raw.provider : 'ollama',
		providers,
		...readSharedSettings(raw),
	};

	// Written by a newer build: keep what we understand, but leave the file alone.
	if (storedVersion > SETTINGS_VERSION) {
		settings.settingsVersion = storedVersion;
		return {settings, migrated: false};
	}

	// An unrecognised provider id falls back to Ollama, and that correction is worth persisting.
	const providerCorrected = raw.provider !== undefined && !isProviderId(raw.provider);

	return {settings, migrated: !allComplete || providerCorrected || storedVersion !== SETTINGS_VERSION};
}
