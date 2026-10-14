import {describe, expect, it} from 'vitest';
import {migrateSettings} from '../src/settings-migration';
import {
	DEFAULT_PROVIDER_CONFIGS,
	defaultSettings,
	PROVIDER_IDS,
	SETTINGS_VERSION,
} from '../src/defaults';
import {
	activeProviderConfig,
	activeProviderId,
	chatEndpoint,
	embeddingEndpoint,
	trimSlash,
} from '../src/settings';
import {PluginSettings} from '../src/types';

/** A realistic pre-2.3 data.json. */
const legacyData = () => ({
	aiModel: 'llama3.1:8b',
	embeddingModel: 'nomic-embed-text',
	dedicatedEmbeddingEnabled: true,
	ollamaURL: 'http://192.168.1.50:11434',
	ragTopK: 5,
	temperature: 0.35,
	isContextFreeChatsEnabled: true,
	embeddingCacheEnabled: true,
	lastContextPath: 'Notes/Projects',
	lastContextType: 'folder',
});

describe('fresh install', () => {
	it('returns defaults and does not ask for a write', () => {
		const {settings, migrated} = migrateSettings(null);

		expect(settings).toEqual(defaultSettings());
		expect(migrated).toBe(false);
	});

	it.each([undefined, [], 'a string', 42])('treats %s as a fresh install', raw => {
		const {settings, migrated} = migrateSettings(raw);

		expect(settings).toEqual(defaultSettings());
		expect(migrated).toBe(false);
	});

	it('does not hand back the shared defaults object', () => {
		const first = migrateSettings(null).settings;
		first.providers.ollama.url = 'http://mutated';

		expect(migrateSettings(null).settings.providers.ollama.url).toBe(
			DEFAULT_PROVIDER_CONFIGS.ollama.url,
		);
		expect(DEFAULT_PROVIDER_CONFIGS.ollama.url).toBe('http://localhost:11434');
	});
});

describe('migrating the legacy flat shape', () => {
	it('folds the flat keys into the ollama provider entry', () => {
		const {settings, migrated} = migrateSettings(legacyData());

		expect(migrated).toBe(true);
		expect(settings.provider).toBe('ollama');
		expect(settings.providers.ollama).toEqual({
			url: 'http://192.168.1.50:11434',
			embeddingUrl: '',
			chatModel: 'llama3.1:8b',
			embeddingModel: 'nomic-embed-text',
			dedicatedEmbeddingEnabled: true,
		});
	});

	it('preserves the provider-independent settings', () => {
		const {settings} = migrateSettings(legacyData());

		expect(settings.ragTopK).toBe(5);
		expect(settings.temperature).toBe(0.35);
		expect(settings.isContextFreeChatsEnabled).toBe(true);
		expect(settings.embeddingCacheEnabled).toBe(true);
		expect(settings.lastContextPath).toBe('Notes/Projects');
		expect(settings.lastContextType).toBe('folder');
	});

	it('gives the other providers their defaults', () => {
		const {settings} = migrateSettings(legacyData());

		expect(settings.providers.llamacpp).toEqual(DEFAULT_PROVIDER_CONFIGS.llamacpp);
	});

	it('drops the legacy keys', () => {
		const {settings} = migrateSettings(legacyData());

		for (const key of ['aiModel', 'ollamaURL', 'dedicatedEmbeddingEnabled']) {
			expect(settings).not.toHaveProperty(key);
		}
	});

	it('stamps the current settings version', () => {
		expect(migrateSettings(legacyData()).settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('detects the legacy shape from any one of the flat keys', () => {
		expect(migrateSettings({aiModel: 'x'}).settings.providers.ollama.chatModel).toBe('x');
		expect(migrateSettings({ollamaURL: 'http://h:1'}).settings.providers.ollama.url).toBe('http://h:1');
		expect(migrateSettings({embeddingModel: 'e'}).settings.providers.ollama.embeddingModel).toBe('e');
		expect(migrateSettings({dedicatedEmbeddingEnabled: true}).settings.providers.ollama.dedicatedEmbeddingEnabled).toBe(true);
	});

	it('falls back to the default URL for an empty or whitespace ollamaURL', () => {
		expect(migrateSettings({aiModel: 'x', ollamaURL: ''}).settings.providers.ollama.url).toBe(
			DEFAULT_PROVIDER_CONFIGS.ollama.url,
		);
		expect(migrateSettings({aiModel: 'x', ollamaURL: '   '}).settings.providers.ollama.url).toBe(
			DEFAULT_PROVIDER_CONFIGS.ollama.url,
		);
	});

	it('substitutes defaults for legacy values of the wrong type', () => {
		const {settings} = migrateSettings({
			aiModel: 42,
			ollamaURL: {nested: true},
			dedicatedEmbeddingEnabled: 'yes',
			temperature: 'hot',
			ragTopK: null,
		});

		expect(settings.providers.ollama.chatModel).toBe('');
		expect(settings.providers.ollama.url).toBe(DEFAULT_PROVIDER_CONFIGS.ollama.url);
		expect(settings.providers.ollama.dedicatedEmbeddingEnabled).toBe(false);
		expect(settings.temperature).toBe(0.1);
		expect(settings.ragTopK).toBe(3);
	});
});

describe('validation of shared settings', () => {
	it.each([
		[0, 1],
		[1, 1],
		[10, 10],
		[99, 10],
		[3.4, 3],
		[-5, 1],
	])('clamps a ragTopK of %s to %s', (input, expected) => {
		expect(migrateSettings({aiModel: 'x', ragTopK: input}).settings.ragTopK).toBe(expected);
	});

	it.each([
		[0.05, 0.1],
		[0.1, 0.1],
		[1.0, 1.0],
		[5, 1.0],
		[-1, 0.1],
	])('clamps a temperature of %s to %s', (input, expected) => {
		expect(migrateSettings({aiModel: 'x', temperature: input}).settings.temperature).toBe(expected);
	});

	it('rejects NaN and Infinity', () => {
		expect(migrateSettings({aiModel: 'x', temperature: NaN}).settings.temperature).toBe(0.1);
		expect(migrateSettings({aiModel: 'x', ragTopK: Infinity}).settings.ragTopK).toBe(3);
	});

	it('keeps a valid file/folder context pair', () => {
		const {settings} = migrateSettings({aiModel: 'x', lastContextPath: 'a.md', lastContextType: 'file'});

		expect(settings.lastContextPath).toBe('a.md');
		expect(settings.lastContextType).toBe('file');
	});

	// replayContextInit needs both, so a half-set pair is dead weight that can only confuse
	// later reads. Normalising it here removes the half-state entirely.
	it.each([
		{lastContextPath: 'a.md'},
		{lastContextType: 'file'},
		{lastContextPath: '', lastContextType: 'file'},
		{lastContextPath: 'a.md', lastContextType: 'neither'},
		{lastContextPath: 42, lastContextType: 'file'},
	])('nulls both halves of an incomplete context pair (%o)', partial => {
		const {settings} = migrateSettings({aiModel: 'x', ...partial});

		expect(settings.lastContextPath).toBeNull();
		expect(settings.lastContextType).toBeNull();
	});
});

describe('current-shape settings', () => {
	const current = (): PluginSettings => {
		const settings = defaultSettings();
		settings.provider = 'llamacpp';
		settings.providers.ollama.chatModel = 'llama3';
		settings.providers.llamacpp.chatModel = 'qwen';
		settings.ragTopK = 7;
		return settings;
	};

	it('round-trips complete settings without asking for a write', () => {
		const {settings, migrated} = migrateSettings(current());

		expect(settings).toEqual(current());
		expect(migrated).toBe(false);
	});

	it('keeps each provider config separate', () => {
		const {settings} = migrateSettings(current());

		expect(settings.providers.ollama.chatModel).toBe('llama3');
		expect(settings.providers.llamacpp.chatModel).toBe('qwen');
	});

	it('fills in a provider entry added by a later version, and asks for a write', () => {
		const raw = current() as unknown as Record<string, unknown>;
		delete (raw.providers as Record<string, unknown>).llamacpp;

		const {settings, migrated} = migrateSettings(raw);

		expect(settings.providers.llamacpp).toEqual(DEFAULT_PROVIDER_CONFIGS.llamacpp);
		expect(migrated).toBe(true);
	});

	it('fills in a field added by a later version, and asks for a write', () => {
		const raw = current() as unknown as Record<string, unknown>;
		delete ((raw.providers as Record<string, Record<string, unknown>>).ollama).embeddingUrl;

		const {settings, migrated} = migrateSettings(raw);

		expect(settings.providers.ollama.embeddingUrl).toBe('');
		expect(settings.providers.ollama.chatModel).toBe('llama3');
		expect(migrated).toBe(true);
	});

	// llama.cpp's embedding model always runs on a second server, so its address has a default,
	// shown as the field's placeholder. A blank saved by an earlier build would otherwise look set.
	it('defaults llama.cpp\'s embedding server to the second server\'s port', () => {
		expect(DEFAULT_PROVIDER_CONFIGS.llamacpp.embeddingUrl).toBe('http://localhost:8081');
	});

	it('fills a blank llama.cpp embedding server URL with the default, and asks for a write', () => {
		const raw = current();
		raw.providers.llamacpp.embeddingUrl = '';

		const {settings, migrated} = migrateSettings(raw);

		expect(settings.providers.llamacpp.embeddingUrl).toBe('http://localhost:8081');
		expect(migrated).toBe(true);
	});

	it('fills a blank server URL with the default', () => {
		const raw = current();
		raw.providers.llamacpp.url = '  ';

		expect(migrateSettings(raw).settings.providers.llamacpp.url).toBe('http://localhost:8080');
	});

	// Ollama hosts every model on one server, so blank means "the main URL" there.
	it('keeps a blank embedding URL where blank is the default', () => {
		expect(migrateSettings(current()).settings.providers.ollama.embeddingUrl).toBe('');
	});

	it('falls back to ollama for an unrecognised provider id, and asks for a write', () => {
		const raw = {...current(), provider: 'openai'};

		const {settings, migrated} = migrateSettings(raw);

		expect(settings.provider).toBe('ollama');
		expect(migrated).toBe(true);
	});

	it('preserves the other providers when correcting an unrecognised id', () => {
		const {settings} = migrateSettings({...current(), provider: 'openai'});

		expect(settings.providers.llamacpp.chatModel).toBe('qwen');
	});

	it('replaces a non-object providers value with defaults', () => {
		const {settings, migrated} = migrateSettings({settingsVersion: SETTINGS_VERSION, providers: 'nope'});

		expect(settings.providers.ollama).toEqual(DEFAULT_PROVIDER_CONFIGS.ollama);
		expect(migrated).toBe(true);
	});
});

describe('settings from a newer plugin version', () => {
	// Downgrading must not destroy configuration this build cannot represent, so the file is
	// read as best it can be and deliberately left alone.
	const newer = () => ({
		...defaultSettings(),
		settingsVersion: SETTINGS_VERSION + 5,
		provider: 'ollama',
		someFutureSetting: {enabled: true},
	});

	it('never asks for a write', () => {
		expect(migrateSettings(newer()).migrated).toBe(false);
	});

	it('keeps the newer version number rather than downgrading it', () => {
		expect(migrateSettings(newer()).settings.settingsVersion).toBe(SETTINGS_VERSION + 5);
	});

	it('still reads the settings it understands', () => {
		const raw = newer();
		raw.providers.ollama.chatModel = 'llama3';

		expect(migrateSettings(raw).settings.providers.ollama.chatModel).toBe('llama3');
	});

	it('does not ask for a write even when a provider entry is missing', () => {
		const raw = newer() as unknown as Record<string, unknown>;
		delete (raw.providers as Record<string, unknown>).llamacpp;

		expect(migrateSettings(raw).migrated).toBe(false);
	});
});

describe('accessors', () => {
	it.each(PROVIDER_IDS)('resolves the active config for %s', provider => {
		const settings = defaultSettings();
		settings.provider = provider;

		expect(activeProviderConfig(settings)).toBe(settings.providers[provider]);
	});

	it.each(PROVIDER_IDS)('reports %s as the active provider id', provider => {
		const settings = defaultSettings();
		settings.provider = provider;

		expect(activeProviderId(settings)).toBe(provider);
	});

	it('falls back to defaults when the active entry is missing', () => {
		const settings = defaultSettings();
		delete (settings.providers as Partial<Record<string, unknown>>).ollama;

		expect(activeProviderConfig(settings)).toEqual(DEFAULT_PROVIDER_CONFIGS.ollama);
	});

	it.each([
		['http://localhost:11434/', 'http://localhost:11434'],
		['http://localhost:11434///', 'http://localhost:11434'],
		['http://localhost:11434', 'http://localhost:11434'],
		['', ''],
	])('trimSlash(%s) is %s', (input, expected) => {
		expect(trimSlash(input)).toBe(expected);
	});

	it('uses the main URL for embeddings when no embedding URL is set', () => {
		expect(embeddingEndpoint({...DEFAULT_PROVIDER_CONFIGS.ollama, embeddingUrl: ''})).toBe(
			'http://localhost:11434',
		);
	});

	it('uses the embedding URL when one is set for the dedicated model', () => {
		expect(embeddingEndpoint({
			...DEFAULT_PROVIDER_CONFIGS.llamacpp,
			embeddingUrl: 'http://localhost:8081/',
			dedicatedEmbeddingEnabled: true,
		})).toBe('http://localhost:8081');
	});

	// The embedding server runs the dedicated model; with that off, the chat model embeds, and it
	// lives on the main server. The settings tab hides the URL then, so it must not apply unseen.
	it('ignores the embedding URL while the dedicated model is off', () => {
		expect(embeddingEndpoint({
			...DEFAULT_PROVIDER_CONFIGS.llamacpp,
			embeddingUrl: 'http://localhost:8081',
			dedicatedEmbeddingEnabled: false,
		})).toBe('http://localhost:8080');
	});

	it('trims the chat endpoint', () => {
		expect(chatEndpoint({...DEFAULT_PROVIDER_CONFIGS.ollama, url: 'http://h:1/'})).toBe('http://h:1');
	});
});
