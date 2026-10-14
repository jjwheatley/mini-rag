/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	__resetNotices,
	__resetSettings,
	__setting,
	DropdownComponent,
	ExtraButtonComponent,
	notices,
	settingRows,
	SliderComponent,
	TextComponent,
	ToggleComponent,
} from '../stubs/obsidian';
import {SettingTab} from '../../src/classes/settings-tab';
import {DEFAULT_PROVIDER_CONFIGS, defaultSettings} from '../../src/defaults';
import {CSS_CLASS_PREFIX} from '../../src/constants';
import {PluginSettings, ProviderId} from '../../src/types';
import {createProvider} from '../../src/providers/factory';
import {AiProvider} from '../../src/providers/types';
import {ProviderUnreachableError} from '../../src/providers/errors';
import MiniRagPlugin from '../../main';

interface SetupOptions {
	provider?: ProviderId;
	models?: string[];
	embeddingModels?: string[];
	embeddingListError?: boolean;
	/** What a failing embedding listing throws; a plain Error by default. */
	embeddingListFailure?: Error;
	modelListError?: string;
	/** What a failing model listing throws instead of a plain Error, such as an unreachable server. */
	modelListFailure?: Error;
	settings?: Partial<PluginSettings>;
	chatModel?: string;
	embeddingModel?: string;
	dedicated?: boolean;
	url?: string;
	embeddingUrl?: string;
}

/**
 * A real provider for the active backend, so capabilities, curated lists, model-name matching and
 * install hints are the genuine ones. Only the network-facing listing calls are stubbed.
 */
function makeAi(settings: PluginSettings, options: SetupOptions): AiProvider {
	const ai = createProvider({settings});
	vi.spyOn(ai, 'getModelList').mockImplementation(async () => {
		if (options.modelListFailure) throw options.modelListFailure;
		if (options.modelListError) throw new Error(options.modelListError);
		return options.models ?? ['llama3:8b', 'nomic-embed-text:latest'];
	});
	if (ai.listEmbeddingModels) {
		vi.spyOn(ai as Required<AiProvider>, 'listEmbeddingModels').mockImplementation(async () => {
			if (options.embeddingListError) throw options.embeddingListFailure ?? new Error('unreachable');
			return options.embeddingModels ?? [];
		});
	}
	vi.spyOn(ai, 'abort');
	return ai;
}

function setup(options: SetupOptions = {}) {
	const settings: PluginSettings = {...defaultSettings(), ...options.settings};
	settings.provider = options.provider ?? 'ollama';
	const config = settings.providers[settings.provider];
	if (options.chatModel !== undefined) config.chatModel = options.chatModel;
	if (options.embeddingModel !== undefined) config.embeddingModel = options.embeddingModel;
	if (options.dedicated !== undefined) config.dedicatedEmbeddingEnabled = options.dedicated;
	if (options.url !== undefined) config.url = options.url;
	if (options.embeddingUrl !== undefined) config.embeddingUrl = options.embeddingUrl;

	const plugin = {
		settings,
		ai: makeAi(settings, options),
		saveSettings: vi.fn(async () => {}),
		notifyChatModelChanged: vi.fn(),
		// Mirrors main.ts: a fresh provider for whatever settings.provider now says.
		loadAI: vi.fn(() => {
			plugin.ai = makeAi(settings, options);
		}),
	};

	const tab = new SettingTab({} as never, plugin as unknown as MiniRagPlugin);
	return {tab, plugin, settings, config, getModelList: vi.mocked(plugin.ai.getModelList)};
}

/** Renders the tab and lets its fire-and-forget refreshModelList() settle. */
async function render(options: SetupOptions = {}) {
	const harness = setup(options);
	harness.tab.display();
	await settle();
	return harness;
}

/** The embedding status while listing: prefixed, since Obsidian styles a bare "is-loading". */
const CHECKING = `${CSS_CLASS_PREFIX}checking`;
const NOMIC_ID = 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The newest row of that name — a re-render leaves the old rows in the stub's registry. */
const control = <T>(name: string, kind: new (...args: never[]) => T): T =>
	__setting(name)?.component(kind) as T;

beforeEach(() => {
	__resetSettings();
	__resetNotices();
	Object.defineProperty(globalThis.navigator, 'clipboard', {
		value: {writeText: vi.fn(async () => {})},
		configurable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('display', () => {
	it('renders every setting row in order', async () => {
		await render();

		expect(settingRows.map(row => row.name)).toEqual([
			'1. Choose a provider',
			'Provider',
			'2. Connect to Ollama',
			'Ollama URL',
			'Chat Model',
			'Use a dedicated embedding model',
			'Embedding Model',
			'3. Tune your chats',
			'Temperature',
			'Retrieved chunks (top-K)',
			'Enable context-free chats',
			'Cache embeddings on disk',
		]);
	});

	// A first-time user needs "do this, then this"; the steps also say which settings change with
	// the provider (step 2) and which every provider shares (step 3).
	describe('steps', () => {
		const heading = (name: string) => settingRows.filter(row => row.name === name && row.isHeading).pop();
		const headings = () => settingRows.filter(row => row.isHeading).map(row => row.name);

		it('numbers the three steps, in order', async () => {
			await render();

			expect(headings()).toEqual(['1. Choose a provider', '2. Connect to Ollama', '3. Tune your chats']);
		});

		// The step names say enough; descriptions under them only made the page busier.
		it('leaves the steps undescribed', async () => {
			await render({provider: 'llamacpp'});

			for (const name of ['1. Choose a provider', '2. Connect to llama.cpp', '3. Tune your chats']) {
				expect(heading(name)?.desc).toBe('');
			}
		});

		// Step 2 names the provider, which is what ties it to the choice in step 1.
		it('renames the second step on a switch', async () => {
			await render();

			await control('Provider', DropdownComponent).trigger('llamacpp');

			expect(headings()).toContain('2. Connect to llama.cpp');
		});

		// Whether step 2 is done, at a glance, from the model-list check the tab makes anyway.
		describe('connection status', () => {
			const status = () =>
				__setting('2. Connect to Ollama')?.controlEl.querySelector(`.${CSS_CLASS_PREFIX}connection-status`) as HTMLElement | null;

			it('says it is checking while the model list loads', async () => {
				const harness = setup();
				let finish: (models: string[]) => void = () => {};
				harness.getModelList.mockImplementationOnce(() => new Promise(resolve => {
					finish = resolve;
				}));
				harness.tab.display();
				await settle();

				expect(status()?.textContent).toBe('Checking…');

				finish(['llama3']);
				await settle();
				expect(status()?.textContent).toBe('✓ Connected');
			});

			it('says connected once the server answers', async () => {
				await render();

				expect(status()?.textContent).toBe('✓ Connected');
				expect(status()?.classList.contains('is-connected')).toBe(true);
			});

			// Reachable is what step 2 is about; an empty list has its own warning on the row.
			it('says connected even when the server has no models', async () => {
				await render({models: []});

				expect(status()?.textContent).toBe('✓ Connected');
			});

			it('says not connected when the server cannot be reached', async () => {
				await render({modelListError: 'ECONNREFUSED'});

				expect(status()?.textContent).toBe('Not connected');
				expect(status()?.classList.contains('is-connected')).toBe(false);
				expect(status()?.classList.contains('is-disconnected')).toBe(true);
			});

			it('checks again from the refresh button', async () => {
				const {getModelList} = await render({modelListError: 'ECONNREFUSED'});
				getModelList.mockResolvedValueOnce(['llama3']);

				await control('Chat Model', ExtraButtonComponent).click();
				await settle();

				expect(status()?.textContent).toBe('✓ Connected');
			});
		});
	});

	it('empties the container so a re-render does not duplicate rows', async () => {
		const {tab} = await render();
		const firstPass = tab.containerEl.children.length;

		tab.display();

		expect(tab.containerEl.children.length).toBe(firstPass);
	});

	it('loads the model list on render', async () => {
		const {getModelList} = await render();

		expect(getModelList).toHaveBeenCalled();
	});
});

describe('provider selector', () => {
	const dropdown = () => control('Provider', DropdownComponent);

	it('offers every provider by name', async () => {
		await render();

		expect(dropdown().optionValues()).toEqual(['ollama', 'llamacpp']);
		expect(dropdown().optionLabels()).toEqual(['Ollama', 'llama.cpp']);
	});

	it('selects the active provider', async () => {
		await render({provider: 'llamacpp'});

		expect(dropdown().getValue()).toBe('llamacpp');
	});

	describe('switching', () => {
		it('saves the choice', async () => {
			const {settings, plugin} = await render();

			await dropdown().trigger('llamacpp');

			expect(settings.provider).toBe('llamacpp');
			expect(plugin.saveSettings).toHaveBeenCalled();
		});

		// The old provider may be mid-answer. A new one replaces it, which also starts a fresh
		// conversation — the new backend knows nothing of the old one's history.
		it('aborts the old provider and builds a new one', async () => {
			const {plugin} = await render();
			const old = plugin.ai;

			await dropdown().trigger('llamacpp');

			expect(old.abort).toHaveBeenCalled();
			expect(plugin.loadAI).toHaveBeenCalled();
			expect(plugin.ai).not.toBe(old);
		});

		it('re-renders for the new provider', async () => {
			const {tab} = await render();

			await dropdown().trigger('llamacpp');

			expect(tab.containerEl.textContent).toContain('llama.cpp URL');
			expect(tab.containerEl.textContent).not.toContain('Ollama URL');
		});

		// URLs and model choices are stored per provider, so trying another backend and coming
		// back loses nothing.
		it('keeps each provider\'s URL across a round trip', async () => {
			const {settings} = await render({url: 'http://gpu-box:11434'});

			await dropdown().trigger('llamacpp');
			expect(control('llama.cpp URL', TextComponent).getValue()).toBe(DEFAULT_PROVIDER_CONFIGS.llamacpp.url);

			await dropdown().trigger('ollama');
			expect(control('Ollama URL', TextComponent).getValue()).toBe('http://gpu-box:11434');
			expect(settings.providers.ollama.url).toBe('http://gpu-box:11434');
		});

		// An open chat panel would otherwise go on naming the old provider's model.
		it('tells an open chat about the switch', async () => {
			const {plugin} = await render();

			await dropdown().trigger('llamacpp');

			expect(plugin.notifyChatModelChanged).toHaveBeenCalledTimes(1);
		});

		it('does nothing when the active provider is chosen again', async () => {
			const {plugin} = await render();

			await dropdown().trigger('ollama');

			expect(plugin.loadAI).not.toHaveBeenCalled();
		});

		// A list requested from the old provider can arrive after the switch. It must not be
		// written into the new provider's dropdown, nor stop the new provider's own list loading.
		it('ignores a model list from the old provider that arrives after switching', async () => {
			const {tab, getModelList} = await render({models: ['current-model']});
			let release: (models: string[]) => void = () => {};
			getModelList.mockImplementationOnce(() => new Promise(resolve => {
				release = resolve;
			}));
			const stale = tab.refreshModelList();

			await dropdown().trigger('llamacpp');
			await settle();
			release(['stale-model']);
			await stale;

			const offered = control('Chat Model', DropdownComponent).optionValues();
			expect(offered).toContain('current-model');
			expect(offered).not.toContain('stale-model');
		});
	});
});

describe('server URL', () => {
	it('shows the configured URL, with the default as the placeholder', async () => {
		await render({url: 'http://192.168.1.5:11434'});
		const text = control('Ollama URL', TextComponent);

		expect(text.getValue()).toBe('http://192.168.1.5:11434');
		expect(text.placeholder).toBe(DEFAULT_PROVIDER_CONFIGS.ollama.url);
	});

	it('is named for the active provider, with its default port', async () => {
		await render({provider: 'llamacpp'});

		expect(control('llama.cpp URL', TextComponent).placeholder).toBe('http://localhost:8080');
	});

	it('saves a change to the active provider config', async () => {
		const {config, plugin} = await render();

		await control('Ollama URL', TextComponent).trigger('http://elsewhere:1234');

		expect(config.url).toBe('http://elsewhere:1234');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('trims whitespace around the URL', async () => {
		const {config} = await render();

		await control('Ollama URL', TextComponent).trigger('  http://trimmed:1  ');

		expect(config.url).toBe('http://trimmed:1');
	});

	// Clearing the field should not leave the plugin with no endpoint at all.
	it('falls back to the default when cleared', async () => {
		const {config} = await render();

		await control('Ollama URL', TextComponent).trigger('   ');

		expect(config.url).toBe(DEFAULT_PROVIDER_CONFIGS.ollama.url);
	});

	it('writes the normalised value back into the field', async () => {
		await render();
		const text = control('Ollama URL', TextComponent);

		await text.trigger('  http://trimmed:1  ');

		expect(text.getValue()).toBe('http://trimmed:1');
	});

	// Typing a URL character by character would otherwise fire a request per keystroke.
	it('debounces the model refresh by 400ms', async () => {
		const {getModelList} = await render();
		vi.useFakeTimers();
		getModelList.mockClear();

		await control('Ollama URL', TextComponent).trigger('http://a:1');
		await vi.advanceTimersByTimeAsync(399);
		expect(getModelList).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(getModelList).toHaveBeenCalledTimes(1);
	});

	it('collapses rapid edits into a single refresh', async () => {
		const {getModelList} = await render();
		vi.useFakeTimers();
		getModelList.mockClear();
		const text = control('Ollama URL', TextComponent);

		await text.trigger('http://a:1');
		await vi.advanceTimersByTimeAsync(200);
		await text.trigger('http://ab:1');
		await vi.advanceTimersByTimeAsync(200);
		await text.trigger('http://abc:1');
		await vi.advanceTimersByTimeAsync(400);

		expect(getModelList).toHaveBeenCalledTimes(1);
	});
});

describe('embedding server URL', () => {
	const embeddingServerContainer = () =>
		__setting('Embedding server URL')?.settingEl.parentElement as HTMLElement;

	// llama-server serves one model per process, so a dedicated embedding model runs as a second
	// server on its own port.
	// It only matters for the dedicated model, so it sits with it: after the toggle, before the
	// model it lists.
	it('appears for llama.cpp, between the dedicated toggle and the embedding model', async () => {
		await render({provider: 'llamacpp'});
		const names = settingRows.map(row => row.name);

		expect(names.indexOf('Embedding server URL')).toBe(names.indexOf('Use a dedicated embedding model') + 1);
		expect(names.indexOf('Embedding Model')).toBe(names.indexOf('Embedding server URL') + 1);
	});

	it('is hidden while the dedicated model is off', async () => {
		await render({provider: 'llamacpp', dedicated: false});

		expect(embeddingServerContainer().style.display).toBe('none');
	});

	it('shows and hides with the dedicated toggle', async () => {
		await render({provider: 'llamacpp', dedicated: false});
		const toggle = control('Use a dedicated embedding model', ToggleComponent);

		await toggle.trigger(true);
		expect(embeddingServerContainer().style.display).toBe('');

		await toggle.trigger(false);
		expect(embeddingServerContainer().style.display).toBe('none');
	});

	it('does not appear for Ollama', async () => {
		await render({provider: 'ollama'});

		expect(__setting('Embedding server URL')).toBeUndefined();
	});

	// Empty no longer means "use the main URL": the field only appears for the dedicated model,
	// which on llama.cpp always runs on a second server.
	it('describes the field as the second server', async () => {
		await render({provider: 'llamacpp'});

		expect(__setting('Embedding server URL')?.desc).not.toMatch(/leave empty/i);
		expect(__setting('Embedding server URL')?.desc).toMatch(/second/i);
	});

	it('shows the configured URL, suggesting the second server\'s port', async () => {
		await render({provider: 'llamacpp', embeddingUrl: 'http://localhost:9090'});
		const text = control('Embedding server URL', TextComponent);

		expect(text.getValue()).toBe('http://localhost:9090');
		expect(text.placeholder).toBe('http://localhost:8081');
	});

	it('saves a trimmed value', async () => {
		const {config, plugin} = await render({provider: 'llamacpp'});

		await control('Embedding server URL', TextComponent).trigger('  http://localhost:8081  ');

		expect(config.embeddingUrl).toBe('http://localhost:8081');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	// Like the main URL: a cleared field falls back to the default it shows as a placeholder,
	// rather than saving a blank that looks like the placeholder's value.
	it('restores the default when cleared', async () => {
		const {config} = await render({provider: 'llamacpp', embeddingUrl: 'http://localhost:9090'});
		const text = control('Embedding server URL', TextComponent);

		await text.trigger('   ');

		expect(config.embeddingUrl).toBe('http://localhost:8081');
		expect(text.getValue()).toBe('http://localhost:8081');
	});

	it('shows the default for a fresh install, rather than only suggesting it', async () => {
		await render({provider: 'llamacpp'});

		expect(control('Embedding server URL', TextComponent).getValue()).toBe('http://localhost:8081');
	});
});

describe('chat model selector', () => {
	// llama-server runs one model, whatever is chosen, so the choice follows it.
	describe('a server that decides the model', () => {
		it('follows the chat model the llama.cpp server runs', async () => {
			const {config, plugin} = await render({provider: 'llamacpp', chatModel: '/models/old-choice.gguf', models: ['bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M']});

			expect(config.chatModel).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
			expect(control('Chat Model', DropdownComponent).getValue()).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
			expect(control('Chat Model', DropdownComponent).optionLabels()).not.toContain('old-choice (not in list)');
			expect(plugin.saveSettings).toHaveBeenCalled();
		});

		// Ollama loads whichever model is chosen, so a choice it does not list stays chosen.
		it('leaves the chosen model alone on Ollama', async () => {
			const {config} = await render({chatModel: 'mistral', models: ['llama3']});

			expect(config.chatModel).toBe('mistral');
		});

		it('leaves the choice alone when the server lists several', async () => {
			const {config} = await render({provider: 'llamacpp', chatModel: 'a.gguf', models: ['b.gguf', 'c.gguf']});

			expect(config.chatModel).toBe('a.gguf');
		});
	});

	it('tells an open chat when the model is changed here', async () => {
		const {plugin} = await render({models: ['llama3', 'mistral'], chatModel: 'llama3'});

		await control('Chat Model', DropdownComponent).trigger('mistral');

		expect(plugin.notifyChatModelChanged).toHaveBeenCalledTimes(1);
	});

	// An empty picker looks broken; it should say what is going on.
	describe('when there is no list to show', () => {
		const picker = () => control('Chat Model', DropdownComponent);

		it('says it is loading, and holds the picker, while the list is fetched', async () => {
			const harness = setup();
			let finish: (models: string[]) => void = () => {};
			harness.getModelList.mockImplementationOnce(() => new Promise(resolve => {
				finish = resolve;
			}));
			harness.tab.display();
			await settle();

			expect(picker().optionLabels()).toEqual(['Loading…']);
			expect(picker().selectEl.disabled).toBe(true);

			finish(['llama3']);
			await settle();

			expect(picker().selectEl.disabled).toBe(false);
			expect(picker().optionLabels()).toContain('llama3');
		});

		// The status says why; the picker still shows what is configured.
		it('shows the saved model when the server cannot be reached', async () => {
			const id = 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M';
			await render({provider: 'llamacpp', chatModel: id, modelListError: 'ECONNREFUSED'});

			expect(picker().optionLabels()).toEqual(['Qwen2.5-7B-Instruct']);
			expect(picker().getValue()).toBe(id);
			expect(picker().selectEl.disabled).toBe(false);
		});

		it('says there are no models when none is saved either', async () => {
			await render({provider: 'llamacpp', chatModel: '', modelListError: 'ECONNREFUSED'});

			expect(picker().optionLabels()).toEqual(['No models']);
		});
	});

	describe('llama.cpp: how to load another model', () => {
		const hint = () =>
			__setting('Chat Model')?.settingEl.querySelector(`.${CSS_CLASS_PREFIX}settings-hint`) as HTMLElement | null;

		it('shows the command to start llama-server with a model', async () => {
			await render({provider: 'llamacpp'});

			expect(hint()?.textContent).toMatch(/one model at a time/);
			expect(hint()?.querySelector('code')?.textContent).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080');
		});

		// Across the bottom of the row, as the embedding model's hint is.
		it('sits across the bottom of the Chat Model row', async () => {
			await render({provider: 'llamacpp'});
			const row = __setting('Chat Model');

			expect(row?.settingEl.lastElementChild).toBe(hint());
			expect(row?.settingEl.classList.contains(`${CSS_CLASS_PREFIX}setting-with-hint`)).toBe(true);
		});

		// Most needed when no server is running yet: the list is empty and the status says why.
		it('stays, beside the reason, when no server is running', async () => {
			await render({provider: 'llamacpp', modelListError: 'net::ERR_CONNECTION_REFUSED'});
			const status = __setting('Chat Model')?.descEl.querySelector(`.${CSS_CLASS_PREFIX}settings-status`);

			expect(status?.textContent).toContain('Could not reach llama.cpp at http://localhost:8080');
			expect(hint()?.querySelector('code')?.textContent).toContain('--port 8080');
		});

		it('uses the port of the configured URL', async () => {
			await render({provider: 'llamacpp', url: 'http://localhost:9000'});

			expect(hint()?.querySelector('code')?.textContent).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 9000');
		});

		it('follows the URL as it is edited', async () => {
			await render({provider: 'llamacpp'});

			await control('llama.cpp URL', TextComponent).trigger('http://localhost:9100');

			expect(hint()?.querySelector('code')?.textContent).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 9100');
			expect(__setting('Chat Model')?.settingEl.querySelectorAll(`.${CSS_CLASS_PREFIX}settings-hint`)).toHaveLength(1);
		});

		// A long command wraps in a narrow pane; it should break between flags, never inside one.
		it('keeps each flag with its value when the command wraps', async () => {
			await render({provider: 'llamacpp'});
			const code = hint()?.querySelector('code');

			expect(Array.from(code?.querySelectorAll('span') ?? [], span => span.textContent)).toEqual([
				'llama-server',
				'-hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
				'-ngl 99',
				'-c 8192',
				'--port 8080',
			]);
			// Selected by hand, it is still the plain command.
			expect(code?.textContent).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080');
		});

		it('copies the command', async () => {
			await render({provider: 'llamacpp'});

			(hint()?.querySelector('button') as HTMLButtonElement).click();

			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080');
			await settle();
			expect(notices).toEqual(['Command copied']);
		});

		// Ollama lists every model it has; the status line already says to install one if none.
		it('is not shown for Ollama', async () => {
			await render();

			expect(hint()).toBeNull();
		});
	});

	it('labels models by name where ids are long, keeping the id as the value', async () => {
		await render({provider: 'llamacpp', models: ['bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M']});
		const option = control('Chat Model', DropdownComponent).selectEl
			.querySelector('option[value="bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"]') as HTMLOptionElement;

		expect(option.textContent).toBe('Qwen2.5-7B-Instruct');
		expect(option.title).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
	});

	it('keeps Ollama ids whole in the chat model list', async () => {
		await render({models: ['llama3:8b', 'llama3:70b']});

		expect(control('Chat Model', DropdownComponent).optionLabels()).toContain('llama3:70b');
	});

	const dropdown = () => control('Chat Model', DropdownComponent);
	const status = () =>
		__setting('Chat Model')?.descEl.querySelector(`.${CSS_CLASS_PREFIX}settings-status`) as HTMLElement;

	it('offers a placeholder plus every installed model', async () => {
		await render({models: ['llama3', 'mistral']});

		expect(dropdown().optionValues()).toEqual(['', 'llama3', 'mistral']);
		expect(dropdown().optionLabels()[0]).toBe('— Select a model —');
	});

	it('selects the configured model', async () => {
		await render({models: ['llama3', 'mistral'], chatModel: 'mistral'});

		expect(dropdown().getValue()).toBe('mistral');
	});

	it('selects the placeholder when nothing is configured', async () => {
		await render({chatModel: ''});

		expect(dropdown().getValue()).toBe('');
	});

	// A model removed from the server should not silently vanish from the settings.
	it('keeps a configured model that is no longer installed, and flags it', async () => {
		await render({models: ['llama3'], chatModel: 'removed-model'});

		expect(dropdown().optionValues()).toContain('removed-model');
		expect(dropdown().optionLabels()).toContain('removed-model (not in list)');
		expect(dropdown().getValue()).toBe('removed-model');
	});

	it('saves a selection', async () => {
		const {config, plugin} = await render({models: ['llama3', 'mistral']});

		await dropdown().trigger('mistral');

		expect(config.chatModel).toBe('mistral');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('replaces the options on refresh rather than appending', async () => {
		const {tab, getModelList} = await render({models: ['llama3']});
		getModelList.mockResolvedValueOnce(['mistral']);

		await tab.refreshModelList();

		expect(dropdown().optionValues()).toEqual(['', 'mistral']);
	});

	it('refreshes from the refresh button', async () => {
		const {getModelList} = await render();
		getModelList.mockClear();

		await control('Chat Model', ExtraButtonComponent).click();

		expect(getModelList).toHaveBeenCalledTimes(1);
	});

	describe('status messages', () => {
		it('warns when no model is chosen', async () => {
			await render({chatModel: ''});

			expect(status().textContent).toContain('No model selected');
			expect(status().classList.contains('is-warning')).toBe(true);
		});

		it('names the active provider in that warning', async () => {
			await render({provider: 'llamacpp', chatModel: ''});

			expect(status().textContent).toContain('Install a model in llama.cpp');
		});

		it('clears the warning once a model is chosen', async () => {
			await render({models: ['llama3'], chatModel: 'llama3'});

			expect(status().textContent).toBe('');
			expect(status().classList.contains('is-warning')).toBe(false);
		});

		it('re-evaluates the warning when the selection changes', async () => {
			await render({models: ['llama3'], chatModel: 'llama3'});

			await dropdown().trigger('');

			expect(status().textContent).toContain('No model selected');
		});

		it('warns, naming the URL, when the server returns no models', async () => {
			await render({models: [], url: 'http://localhost:9999'});

			expect(status().textContent).toContain('http://localhost:9999');
			expect(status().classList.contains('is-warning')).toBe(true);
			expect(__setting('Chat Model')?.desc).toContain('No models found');
		});

		it('reports an unreachable server as an error, with the detail', async () => {
			await render({modelListError: 'ECONNREFUSED'});

			expect(status().textContent).toContain('Could not reach Ollama');
			expect(status().textContent).toContain('ECONNREFUSED');
			expect(status().classList.contains('is-error')).toBe(true);
		});

		// "Could not reach llama.cpp at …. Could not reach the server at …/v1/models." said it twice.
		it('says plainly when nothing is running at the URL', async () => {
			await render({
				provider: 'llamacpp',
				modelListFailure: new ProviderUnreachableError('http://localhost:8080/v1/models', 'net::ERR_CONNECTION_REFUSED'),
			});

			expect(status().textContent).toBe('Nothing is running at http://localhost:8080.');
			expect(status().classList.contains('is-error')).toBe(true);
		});

		it('names the active provider when it is unreachable', async () => {
			await render({provider: 'llamacpp', modelListError: 'ECONNREFUSED'});

			expect(status().textContent).toContain('Could not reach llama.cpp at http://localhost:8080');
		});

		it('does not leave a stale error after a successful refresh', async () => {
			const {tab, getModelList} = await render({modelListError: 'ECONNREFUSED'});
			expect(status().classList.contains('is-error')).toBe(true);
			getModelList.mockImplementationOnce(async () => ['llama3']);

			await tab.refreshModelList();

			expect(status().classList.contains('is-error')).toBe(false);
		});
	});

	// Two refreshes at once would race on the same dropdown.
	it('ignores a refresh while one is already running', async () => {
		const {tab, getModelList} = await render();
		getModelList.mockClear();
		let release: (models: string[]) => void = () => {};
		getModelList.mockImplementationOnce(() => new Promise(resolve => {
			release = resolve;
		}));

		const first = tab.refreshModelList();
		await tab.refreshModelList();
		release(['llama3']);
		await first;

		expect(getModelList).toHaveBeenCalledTimes(1);
	});
});

describe('temperature', () => {
	it('shows the configured value within the model-friendly range', async () => {
		await render({settings: {temperature: 0.45}});
		const slider = control('Temperature', SliderComponent);

		expect(slider.getValue()).toBe(0.45);
		expect(slider.limits).toEqual({min: 0.1, max: 1.0, step: 0.05});
		expect(slider.dynamicTooltip).toBe(true);
	});

	it('saves a change', async () => {
		const {settings, plugin} = await render();

		await control('Temperature', SliderComponent).trigger(0.8);

		expect(settings.temperature).toBe(0.8);
		expect(plugin.saveSettings).toHaveBeenCalled();
	});
});

describe('top-K', () => {
	it('shows the configured value as a whole-number slider', async () => {
		await render({settings: {ragTopK: 5}});
		const slider = control('Retrieved chunks (top-K)', SliderComponent);

		expect(slider.getValue()).toBe(5);
		expect(slider.limits).toEqual({min: 1, max: 10, step: 1});
	});

	it('saves a change', async () => {
		const {settings} = await render();

		await control('Retrieved chunks (top-K)', SliderComponent).trigger(9);

		expect(settings.ragTopK).toBe(9);
	});
});

describe('simple toggles', () => {
	it.each([
		['Enable context-free chats', 'isContextFreeChatsEnabled'],
		['Cache embeddings on disk', 'embeddingCacheEnabled'],
	] as const)('%s reflects and saves %s', async (label, key) => {
		const {settings, plugin} = await render({settings: {[key]: false}});
		const toggle = control(label, ToggleComponent);
		expect(toggle.getValue()).toBe(false);

		await toggle.trigger(true);

		expect(settings[key]).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalled();
	});
});

describe('dedicated embedding model', () => {
	const toggle = () => control('Use a dedicated embedding model', ToggleComponent);
	const dropdown = () => control('Embedding Model', DropdownComponent);
	const status = () =>
		__setting('Embedding Model')?.descEl.querySelector(`.${CSS_CLASS_PREFIX}settings-status`) as HTMLElement;
	// The picker lives in an unclassed wrapper div whose display is toggled; find it as the
	// parent of the Embedding Model row rather than by selector, which would also match rows.
	const container = () => __setting('Embedding Model')?.settingEl.parentElement as HTMLElement;
	// The details of a missing model, under the status in the description.
	const callout = () => container().querySelector(`.${CSS_CLASS_PREFIX}settings-hint`) as HTMLElement | null;
	/** The hint's lines of explanation, without its command. */
	const hintLines = () => Array.from(
		callout()?.querySelectorAll(`.${CSS_CLASS_PREFIX}settings-hint-line`) ?? [],
		line => line.textContent,
	);
	const calloutText = () => callout()?.textContent ?? '';
	/** The options under the picker's "Running" heading, for llama.cpp. */
	const runningGroup = () => Array.from(
		dropdown().selectEl.querySelectorAll('optgroup[label="Running"] option'),
		option => (option as HTMLOptionElement).value,
	);

	it('reflects the configured toggle state', async () => {
		await render({dedicated: true});

		expect(toggle().getValue()).toBe(true);
	});

	// The picker shows its first model when none is saved; indexing must use that same model,
	// not fall back to the chat model behind the user's back.
	it('saves the model the picker shows when none was saved', async () => {
		const {config, plugin} = await render({
			provider: 'llamacpp',
			embeddingModels: ['nomic-embed.gguf'],
			embeddingUrl: 'http://localhost:8081',
			embeddingModel: '',
			dedicated: true,
		});

		expect(config.embeddingModel).toBe('nomic-embed.gguf');
		expect(plugin.saveSettings).toHaveBeenCalled();
		expect(status().classList.contains('is-success')).toBe(true);
	});

	it('leaves the choice alone while the dedicated model is off', async () => {
		const {config} = await render({
			provider: 'llamacpp',
			embeddingModels: ['nomic-embed.gguf'],
			embeddingModel: '',
			dedicated: false,
		});

		expect(config.embeddingModel).toBe('');
	});

	it('does not save when there is nothing to pick', async () => {
		const {plugin} = await render({provider: 'llamacpp', embeddingModels: [], embeddingModel: '', dedicated: true});

		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it('names the active provider in its description', async () => {
		await render({provider: 'llamacpp'});

		expect(__setting('Use a dedicated embedding model')?.desc).toContain('llama.cpp');
	});

	it('hides the model picker while the toggle is off', async () => {
		await render({dedicated: false});

		expect(container().style.display).toBe('none');
	});

	it('shows the model picker while the toggle is on', async () => {
		await render({dedicated: true});

		expect(container().style.display).toBe('');
	});

	it('reveals the picker when switched on', async () => {
		const {config} = await render({dedicated: false});

		await toggle().trigger(true);

		expect(config.dedicatedEmbeddingEnabled).toBe(true);
		expect(container().style.display).toBe('');
	});

	it('hides the picker again when switched off', async () => {
		await render({dedicated: true});

		await toggle().trigger(false);

		expect(container().style.display).toBe('none');
	});

	describe('Ollama: curated list', () => {
		// Enabling with nothing chosen should land on something the user already has, so the very
		// next index build works without a download.
		it('defaults to an installed curated model when switched on', async () => {
			const {config} = await render({
				models: ['llama3:8b', 'nomic-embed-text:latest'],
				embeddingModel: '',
				dedicated: false,
			});

			await toggle().trigger(true);

			expect(config.embeddingModel).toBe('nomic-embed-text:latest');
		});

		it('falls back to the first curated model when none is installed', async () => {
			const {config} = await render({models: ['llama3'], embeddingModel: '', dedicated: false});

			await toggle().trigger(true);

			expect(config.embeddingModel).toBe('all-minilm');
		});

		it('keeps an existing choice when switched on', async () => {
			const {config} = await render({embeddingModel: 'bge-m3', dedicated: false});

			await toggle().trigger(true);

			expect(config.embeddingModel).toBe('bge-m3');
		});

		it('offers the provider\'s curated models', async () => {
			const {plugin} = await render({models: [], dedicated: true});

			// After the placeholder, since nothing is saved yet.
			expect(dropdown().optionValues()).toEqual(['', ...plugin.ai.curatedEmbeddingModels()]);
		});

		it('splits the curated list into installed and not installed', async () => {
			await render({models: ['nomic-embed-text:latest'], dedicated: true});

			expect(dropdown().groupLabels()).toEqual(['Installed', 'Not installed']);
		});

		// Ollama reports "name:tag" while the curated list holds bare names.
		it('matches an installed model ignoring its tag', async () => {
			await render({models: ['nomic-embed-text:latest'], dedicated: true});
			const installed = dropdown().selectEl.querySelector('optgroup[label="Installed"]');

			expect(installed?.textContent).toContain('nomic-embed-text');
		});

		it('omits the Installed group when nothing curated is installed', async () => {
			await render({models: ['llama3'], dedicated: true});

			expect(dropdown().groupLabels()).toEqual(['Not installed']);
		});

		it('keeps a saved model that is not in the curated list', async () => {
			await render({models: [], embeddingModel: 'custom-embedder', dedicated: true});

			expect(dropdown().optionLabels()).toContain('custom-embedder (not in list)');
			expect(dropdown().getValue()).toBe('custom-embedder');
		});

		it('saves a selection', async () => {
			const {config, plugin} = await render({dedicated: true});

			await dropdown().trigger('bge-m3');

			expect(config.embeddingModel).toBe('bge-m3');
			expect(plugin.saveSettings).toHaveBeenCalled();
		});

		it('rebuilds the options on refresh rather than appending', async () => {
			const {getModelList} = await render({models: [], dedicated: true, embeddingModel: 'bge-m3'});
			const before = dropdown().optionValues().length;
			getModelList.mockResolvedValueOnce(['nomic-embed-text']);

			await control('Embedding Model', ExtraButtonComponent).click();

			expect(dropdown().optionValues()).toHaveLength(before);
		});

		it('survives an unreachable server when checking install status', async () => {
			const {getModelList} = await render({dedicated: true});
			getModelList.mockRejectedValueOnce(new Error('ECONNREFUSED'));

			await expect(control('Embedding Model', ExtraButtonComponent).click()).resolves.toBeUndefined();
		});

		it('confirms an installed model', async () => {
			await render({
				models: ['nomic-embed-text:latest'],
				embeddingModel: 'nomic-embed-text',
				dedicated: true,
			});

			expect(status().textContent).toBe('Installed');
			expect(status().classList.contains('is-success')).toBe(true);
		});

		it('shows the provider\'s install hint for a missing model', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});

			expect(calloutText()).toContain('Mini-RAG expected to find "bge-m3" in Ollama.');
			expect(callout()?.querySelector('code')?.textContent).toBe('ollama pull bge-m3');
			expect(status().classList.contains('is-warning')).toBe(true);
		});

		// In the description, under a short status: a panel between rows made the page jump.
		// Full width, but inside the row: a panel between rows made the page jump, and the
		// description column was too narrow for the command.
		it('puts the details across the bottom of the row, under a short status', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});
			const row = __setting('Embedding Model');

			expect(status().textContent).toBe('Not available');
			expect(status().querySelector('code')).toBeNull();
			expect(callout()?.parentElement).toBe(row?.settingEl);
			expect(row?.settingEl.lastElementChild).toBe(callout());
			expect(row?.settingEl.classList.contains(`${CSS_CLASS_PREFIX}setting-with-hint`)).toBe(true);
		});

		it('explains with the provider\'s hint, without a title', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});

			expect(hintLines()).toEqual(['Mini-RAG expected to find "bge-m3" in Ollama.', 'Run this command:']);
		});

		it('removes the panel once the model is available', async () => {
			await render({models: ['nomic-embed-text:latest'], embeddingModel: 'bge-m3', dedicated: true});

			await dropdown().trigger('nomic-embed-text');

			expect(callout()).toBeNull();
		});

		// "llama3:8b" and "llama3:70b" are different models; the tag is what tells them apart.
		it('keeps Ollama ids whole', async () => {
			await render({dedicated: true, embeddingModel: 'nomic-embed-text'});

			expect(dropdown().optionLabels()).toEqual(dropdown().optionValues());
		});

		it('copies the install command', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});

			(callout()?.querySelector('button') as HTMLButtonElement).click();

			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ollama pull bge-m3');
		});

		// A copy button that does nothing visible leaves the user unsure it worked.
		it('confirms the copy', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});

			(callout()?.querySelector('button') as HTMLButtonElement).click();
			await settle();

			expect(notices).toEqual(['Command copied']);
		});

		it('says when the copy failed', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});
			vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));

			(callout()?.querySelector('button') as HTMLButtonElement).click();
			await settle();

			expect(notices).toEqual(['Could not copy to clipboard.']);
		});

		it('replaces the hint rather than stacking it', async () => {
			await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});

			await dropdown().trigger('all-minilm');

			expect(callout()?.querySelectorAll('code')).toHaveLength(1);
			expect(callout()?.querySelector('code')?.textContent).toBe('ollama pull all-minilm');
		});

		it('updates from not-installed to installed as the selection changes', async () => {
			await render({
				models: ['nomic-embed-text:latest'],
				embeddingModel: 'bge-m3',
				dedicated: true,
			});
			expect(status().classList.contains('is-warning')).toBe(true);

			await dropdown().trigger('nomic-embed-text');

			expect(status().textContent).toBe('Installed');
		});

		// A model pulled since the page opened counts as soon as it is chosen.
		it('checks the installed models again when the choice changes', async () => {
			const {getModelList} = await render({models: ['llama3'], embeddingModel: 'bge-m3', dedicated: true});
			getModelList.mockResolvedValueOnce(['llama3', 'nomic-embed-text:latest']);

			await dropdown().trigger('nomic-embed-text');

			expect(status().textContent).toBe('Installed');
		});
	});

	describe('llama.cpp: curated, matched against the embedding server', () => {
		const llamacpp: SetupOptions = {
			provider: 'llamacpp',
			embeddingUrl: 'http://localhost:8081',
			embeddingModels: [NOMIC_ID],
			dedicated: true,
		};

		// The same suggestions as Ollama, split by whether the embedding server is running them:
		// llama-server is started with a model rather than having it installed, so it says "Running".
		it('offers the curated models, split by what the embedding server runs', async () => {
			const {plugin} = await render(llamacpp);

			expect(dropdown().optionValues()).toEqual(expect.arrayContaining(plugin.ai.curatedEmbeddingModels()));
			expect(dropdown().groupLabels()).toEqual(['Running', 'Not running']);
			expect(runningGroup()).toEqual(['nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0']);
		});

		// Listing can take seconds; until it lands the picker says so instead of sitting blank.
	describe('while the embedding models load', () => {
		/** Renders with the embedding listing held open; call the result to let it finish. */
		async function renderLoading(options: SetupOptions) {
			const harness = setup(options);
			let finish: (models: string[]) => void = () => {};
			vi.mocked((harness.plugin.ai as Required<AiProvider>).listEmbeddingModels)
				.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
			harness.tab.display();
			await settle();
			return {...harness, finish: async (models: string[]) => { finish(models); await settle(); }};
		}

		it('says it is checking, and holds the picker', async () => {
			await renderLoading(llamacpp);

			expect(status().textContent).toBe('Checking…');
			expect(status().classList.contains(CHECKING)).toBe(true);
			// Obsidian draws its own progress bar on any "is-loading" element, over the text.
			expect(status().classList.contains('is-loading')).toBe(false);
			expect(status().classList.contains('is-warning')).toBe(false);
			expect(callout()).toBeNull();
			expect(dropdown().selectEl.disabled).toBe(true);
			expect(dropdown().optionLabels()).toEqual(['Loading…']);
		});

		it('shows the result once the list arrives', async () => {
			const {finish} = await renderLoading(llamacpp);

			await finish([NOMIC_ID]);

			expect(status().textContent).toBe('Running');
			expect(status().classList.contains(CHECKING)).toBe(false);
			expect(dropdown().selectEl.disabled).toBe(false);
			expect(dropdown().optionLabels()).not.toContain('Loading…');
		});

		it('checks again, visibly, from the refresh button', async () => {
			const {plugin} = await render(llamacpp);
			vi.mocked((plugin.ai as Required<AiProvider>).listEmbeddingModels)
				.mockImplementationOnce(() => new Promise(() => {}));

			void control('Embedding Model', ExtraButtonComponent).click();
			await settle();

			expect(status().textContent).toBe('Checking…');
		});
	});

	// llama.cpp's embedding server is separate, so a stopped chat server says nothing about it.
	it('lists the embedding server even when the chat server is down', async () => {
		await render({...llamacpp, modelListError: 'ECONNREFUSED', embeddingModel: NOMIC_ID});

		expect(status().textContent).toBe('Running');
	});

	// Where one server hosts both, there is nothing more to learn; just stop checking.
	it('stops checking when the chat server is down and hosts the embedder too', async () => {
		await render({modelListError: 'ECONNREFUSED', dedicated: true, embeddingModel: 'bge-m3'});

		expect(status().classList.contains(CHECKING)).toBe(false);
		expect(dropdown().selectEl.disabled).toBe(false);
	});

	// Saving a suggestion nothing runs would stick: starting the server later would not replace
		// it. So with nothing available, the picker waits for a choice instead.
		it('shows a placeholder, saving nothing, while no embedding model is running', async () => {
			const {config} = await render({...llamacpp, embeddingModels: [], embeddingModel: ''});

			expect(config.embeddingModel).toBe('');
			expect(dropdown().getValue()).toBe('');
			expect(dropdown().optionLabels()[0]).toBe('— Select a model —');
		});

		// Hugging Face ids are long; the picker shows the model's name and keeps the id as the value.
		it('labels each model by name, keeping the full id as its value and tooltip', async () => {
			await render(llamacpp);
			const option = dropdown().selectEl.querySelector(`option[value="${NOMIC_ID}"]`) as HTMLOptionElement;

			expect(option.textContent).toBe('nomic-embed-text');
			expect(option.title).toBe(NOMIC_ID);
		});

		// llama-server embeds as whatever it runs, so a different choice is used only once the
		// server is restarted with it; until then, say which model is really in use.
		it('says which model is used when the choice is not the one running', async () => {
			await render({...llamacpp, embeddingModel: 'ggml-org/bge-m3-Q8_0-GGUF'});

			expect(status().textContent).toBe('Not running — using nomic-embed-text');
			expect(status().classList.contains('is-warning')).toBe(true);
			expect(hintLines()).toEqual([
				'The embedding server is running nomic-embed-text, so Mini-RAG uses that. To use bge-m3 instead, restart it with:',
			]);
			expect(callout()?.querySelector('code')?.textContent).toBe(
				'llama-server -hf ggml-org/bge-m3-Q8_0-GGUF --embeddings --port 8081',
			);
		});

		// Whatever the server runs is a valid choice, listed or not.
		it('includes a running model that is not on the list', async () => {
			await render({...llamacpp, embeddingModels: ['me/custom-embed-GGUF:Q4_K_M']});

			expect(runningGroup()).toEqual(['me/custom-embed-GGUF:Q4_K_M']);
		});

		it('shows how to start a curated model the server is not running', async () => {
			await render({...llamacpp, embeddingModel: 'ggml-org/bge-m3-Q8_0-GGUF'});

			expect(callout()?.querySelector('code')?.textContent).toBe(
				'llama-server -hf ggml-org/bge-m3-Q8_0-GGUF --embeddings --port 8081',
			);
		});

		it('picks it when switched on', async () => {
			const {config} = await render({...llamacpp, dedicated: false, embeddingModel: ''});

			await toggle().trigger(true);

			expect(config.embeddingModel).toBe('nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0');
		});

		it('confirms the running model', async () => {
			await render({...llamacpp, embeddingModel: 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0'});

			expect(status().classList.contains('is-success')).toBe(true);
		});

		// A name typed into an earlier version is kept, with directions for starting that server.
		it('keeps a saved model the server is not running, with the llama-server hint', async () => {
			await render({...llamacpp, embeddingModel: 'nomic.gguf'});

			expect(dropdown().optionLabels()).toContain('nomic (not in list)');
			expect(callout()?.querySelector('code')?.textContent).toBe(
				'llama-server -m nomic.gguf --embeddings --port 8081',
			);
		});

		// No second server yet: nothing to pick, so explain how to start one.
		it('shows how to start an embedding server when none is running', async () => {
			await render({...llamacpp, embeddingModels: [], embeddingModel: ''});

			expect(runningGroup()).toEqual([]);
			expect(callout()?.querySelector('code')?.textContent).toContain('--embeddings --port 8081');
			expect(calloutText()).not.toContain('Enter the Embedding server URL');
		});

		// With no address there is nothing to ask, so the empty picker needs explaining.
		it('asks for the embedding server URL when none is set', async () => {
			// The provider lists nothing without an address.
			await render({...llamacpp, embeddingUrl: '', embeddingModels: [], embeddingModel: ''});

			// The reason is the status itself, so it is not repeated underneath.
			expect(status().textContent).toBe('No embedding server URL set');
			expect(calloutText()).not.toContain('Embedding server URL');
		});

		// The embedding list comes from that server, so changing its address must re-ask it.
		it('re-lists once the embedding server URL settles', async () => {
			const {plugin, config} = await render({...llamacpp, embeddingUrl: '', embeddingModels: [], embeddingModel: ''});
			vi.useFakeTimers();
			const listEmbeddingModels = vi.mocked((plugin.ai as Required<AiProvider>).listEmbeddingModels);
			listEmbeddingModels.mockClear();
			listEmbeddingModels.mockResolvedValue(['embedder.gguf']);
			const text = control('Embedding server URL', TextComponent);

			await text.trigger('http://localhost:80');
			await vi.advanceTimersByTimeAsync(200);
			await text.trigger('http://localhost:8081');
			await vi.advanceTimersByTimeAsync(399);
			expect(listEmbeddingModels).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(listEmbeddingModels).toHaveBeenCalledTimes(1);
			expect(runningGroup()).toEqual(['embedder.gguf']);
			expect(config.embeddingModel).toBe('embedder.gguf');
		});

		// A mistyped address lists nothing; say so rather than leaving a silently empty picker.
		it('says when the embedding server cannot be reached', async () => {
			await render({...llamacpp, embeddingListError: true, embeddingModel: ''});

			expect(status().textContent).toBe('Could not list the embedding models');
			// The server's own words are the detail, then the way to start a server.
			expect(hintLines()[0]).toBe('unreachable');
			expect(callout()?.querySelector('code')?.textContent).toContain('--embeddings --port 8081');
		});

		// "net::ERR_CONNECTION_REFUSED" means nothing is listening there; say that, and where.
		it('says plainly when nothing is running at the embedding server', async () => {
			await render({
				...llamacpp,
				embeddingUrl: 'http://localhost:8082',
				embeddingListError: true,
				embeddingListFailure: new ProviderUnreachableError('http://localhost:8082/v1/models', 'net::ERR_CONNECTION_REFUSED'),
				embeddingModel: '',
			});

			expect(status().textContent).toBe('Nothing is running at http://localhost:8082');
			expect(status().classList.contains('is-warning')).toBe(true);
			// One warning, not two: the hint goes straight to what to run.
			expect(calloutText()).not.toMatch(/could not list|nothing is running/i);
		});

		it('clears that message once the server answers', async () => {
			const {plugin} = await render({...llamacpp, embeddingListError: true, embeddingModel: ''});
			const listEmbeddingModels = vi.mocked((plugin.ai as Required<AiProvider>).listEmbeddingModels);
			listEmbeddingModels.mockResolvedValueOnce(['embedder.gguf']);

			await control('Embedding Model', ExtraButtonComponent).click();

			expect(status().textContent).not.toContain('Could not list');
		});

		// The embedding server is separate, so a stopped chat server must not stop it being checked.
		it('checks the embedding server from the refresh button while the chat server is down', async () => {
			const {plugin} = await render({...llamacpp, modelListError: 'ECONNREFUSED', embeddingListError: true, embeddingModel: NOMIC_ID});
			vi.mocked((plugin.ai as Required<AiProvider>).listEmbeddingModels).mockResolvedValueOnce([NOMIC_ID]);

			await control('Embedding Model', ExtraButtonComponent).click();

			expect(status().textContent).toBe('Running');
		});

		// llama-server can be stopped, or restarted with another model, at any time: a choice is
		// checked against what the embedding server runs now, not when the page opened.
		describe('on choosing a model', () => {
			const listEmbeddingModels = (plugin: {ai: AiProvider}) =>
				vi.mocked((plugin.ai as Required<AiProvider>).listEmbeddingModels);

			it('asks the embedding server again', async () => {
				const {plugin} = await render({...llamacpp, embeddingModel: 'ggml-org/bge-m3-Q8_0-GGUF'});
				listEmbeddingModels(plugin).mockClear();

				await dropdown().trigger(NOMIC_ID);

				expect(listEmbeddingModels(plugin)).toHaveBeenCalledTimes(1);
			});

			it('says it is checking while it does', async () => {
				const {plugin} = await render(llamacpp);
				listEmbeddingModels(plugin).mockImplementationOnce(() => new Promise(() => {}));

				void dropdown().trigger('ggml-org/bge-m3-Q8_0-GGUF');
				await settle();

				expect(status().textContent).toBe('Checking…');
			});

			it('says so when the server has stopped since', async () => {
				const {plugin} = await render({...llamacpp, embeddingModel: 'ggml-org/bge-m3-Q8_0-GGUF'});
				listEmbeddingModels(plugin).mockRejectedValueOnce(
					new ProviderUnreachableError('http://localhost:8081/v1/models', 'net::ERR_CONNECTION_REFUSED'),
				);

				await dropdown().trigger(NOMIC_ID);

				expect(status().textContent).toBe('Nothing is running at http://localhost:8081');
				expect(callout()?.querySelector('code')?.textContent).toBe(
					`llama-server -hf ${NOMIC_ID} --embeddings --port 8081`,
				);
			});

			it('confirms the model once the server runs it', async () => {
				const {plugin, config} = await render({...llamacpp, embeddingModels: [], embeddingModel: 'ggml-org/bge-m3-Q8_0-GGUF'});
				listEmbeddingModels(plugin).mockResolvedValueOnce([NOMIC_ID]);

				await dropdown().trigger(NOMIC_ID);

				expect(status().textContent).toBe('Running');
				expect(config.embeddingModel).toBe(NOMIC_ID);
				expect(dropdown().getValue()).toBe(NOMIC_ID);
			});
		});
	});
});
