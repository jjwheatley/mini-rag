/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetNotices, notices, TFile as StubTFile, TFolder as StubTFolder} from '../stubs/obsidian';
import {SupportModal} from '../../src/classes/ui/support-modal';
import MiniRagPlugin from '../../main';
import {ChatWindow} from '../../src/classes/chat-window';
import {OllamaProvider} from '../../src/providers/ollama-provider';
import {MenuManager} from '../../src/classes/menu-manager';
import {Contextualizer} from '../../src/classes/contextualizer';
import {FileManager} from '../../src/classes/file-manager';
import {SaveChatAsModal} from '../../src/classes/ui/save-chat-as-modal';
import {defaultSettings} from '../../src/defaults';
import type {ProviderId} from '../../src/types';

interface Leaf {
	view: unknown;
	setViewState: ReturnType<typeof vi.fn>;
}

function makeLeaf(view: unknown = null): Leaf {
	return {view, setViewState: vi.fn(async () => {})};
}

function makeApp(options: {leaves?: Leaf[]; rightLeaf?: Leaf | null} = {}) {
	const layoutReady: (() => void)[] = [];
	const files = new Map<string, StubTFile>();
	const folders = new Map<string, StubTFolder>();
	const leaves = options.leaves ?? [];
	return {
		layoutReady,
		files,
		folders,
		leaves,
		app: {
			workspace: {
				getLeavesOfType: vi.fn(() => leaves),
				getRightLeaf: vi.fn(() => (options.rightLeaf === undefined ? makeLeaf() : options.rightLeaf)),
				revealLeaf: vi.fn(async () => {}),
				onLayoutReady: vi.fn((cb: () => void) => layoutReady.push(cb)),
				on: vi.fn(() => ({})),
				getActiveViewOfType: () => null,
			},
			vault: {
				getFileByPath: vi.fn((path: string) => files.get(path) ?? null),
				getFolderByPath: vi.fn((path: string) => folders.get(path) ?? null),
				create: vi.fn(async () => {}),
				createFolder: vi.fn(async () => {}),
				modify: vi.fn(async () => {}),
				cachedRead: vi.fn(async () => ''),
				adapter: {},
			},
			metadataCache: {},
		},
	};
}

function makePlugin(appOptions: Parameters<typeof makeApp>[0] = {}) {
	const harness = makeApp(appOptions);
	const plugin = new MiniRagPlugin(harness.app as never, {} as never);
	return {plugin, ...harness};
}

/** A real ChatWindow with its UI-facing methods observed, so instanceof checks pass. */
function makeChatWindow(plugin: MiniRagPlugin) {
	const view = new ChatWindow({} as never, plugin);
	vi.spyOn(view, 'resetChat').mockImplementation(() => {});
	vi.spyOn(view, 'setAwaitingResponse').mockImplementation(() => {});
	vi.spyOn(view, 'showIndexError').mockImplementation(() => {});
	view.chatStarted = new Date(2026, 8, 10, 14, 30, 45);
	view.savedChatPath = null;
	view.chatMessages = {get: vi.fn(() => [])} as never;
	return view;
}

beforeEach(() => {
	__resetNotices();
});

// The manifest is the one place the funding links are written down.
describe('support', () => {
	// Mini-RAG's own link, then a made-up second one.
	const FUNDING = {'GitHub Sponsors': 'https://github.com/sponsors/jjwheatley', 'Tip jar': 'https://example.com/tip-jar'};
	const withFunding = () => new MiniRagPlugin(makeApp().app as never, {fundingUrl: FUNDING} as never);

	it('reads its funding links from the manifest', () => {
		expect(withFunding().fundingLinks()).toEqual([
			{name: 'GitHub Sponsors', url: FUNDING['GitHub Sponsors']},
			{name: 'Tip jar', url: FUNDING['Tip jar']},
		]);
	});

	it('offers them from a command', async () => {
		const plugin = withFunding();
		const addCommand = vi.spyOn(plugin, 'addCommand');
		const open = vi.spyOn(SupportModal.prototype, 'open').mockImplementation(() => {});
		await plugin.onload();

		const command = addCommand.mock.calls.map(call => call[0]).find(c => c.id === 'support') as {name: string; callback: () => void};
		command.callback();

		expect(command.name).toBe('Support development');
		expect(open).toHaveBeenCalledTimes(1);
		open.mockRestore();
	});

	it('adds no command when the manifest has no funding links', async () => {
		const {plugin} = makePlugin();
		const addCommand = vi.spyOn(plugin, 'addCommand');
		await plugin.onload();

		expect(addCommand.mock.calls.map(call => call[0].id)).not.toContain('support');
	});
});

describe('onload', () => {
	it('wires up settings, services, provider and menus', async () => {
		const {plugin} = makePlugin();

		await plugin.onload();

		expect(plugin.settings).toEqual(defaultSettings());
		expect(plugin.fileManager).toBeInstanceOf(FileManager);
		expect(plugin.context).toBeInstanceOf(Contextualizer);
		expect(plugin.ai).toBeInstanceOf(OllamaProvider);
		expect(plugin.menu).toBeInstanceOf(MenuManager);
	});

	it('registers the settings tab, the chat view and the open-chat command', async () => {
		const {plugin} = makePlugin();
		const addSettingTab = vi.spyOn(plugin, 'addSettingTab');
		const registerView = vi.spyOn(plugin, 'registerView');
		const addCommand = vi.spyOn(plugin, 'addCommand');

		await plugin.onload();

		expect(addSettingTab).toHaveBeenCalledTimes(1);
		expect(registerView.mock.calls[0][0]).toBe('mini-rag-chat-window');
		expect(addCommand.mock.calls[0][0]).toMatchObject({id: 'open-chat', name: 'Open chat panel'});
	});

	it('builds a ChatWindow from the registered view factory', async () => {
		const {plugin} = makePlugin();
		const registerView = vi.spyOn(plugin, 'registerView');
		await plugin.onload();

		const factory = registerView.mock.calls[0][1] as (leaf: unknown) => unknown;

		expect(factory({})).toBeInstanceOf(ChatWindow);
	});

	it('opens the panel from the command', async () => {
		const {plugin, app} = makePlugin();
		const addCommand = vi.spyOn(plugin, 'addCommand');
		await plugin.onload();

		(addCommand.mock.calls[0][0] as {callback: () => void}).callback();
		await Promise.resolve();

		expect(app.workspace.getRightLeaf).toHaveBeenCalled();
	});

	it('defers context restore until the layout is ready', async () => {
		const {plugin, layoutReady} = makePlugin();

		await plugin.onload();

		expect(layoutReady).toHaveLength(1);
	});
});

describe('loadSettings', () => {
	// A fresh install should not get a data.json it never asked for.
	it('does not write on a fresh install', async () => {
		const {plugin} = makePlugin();
		const save = vi.spyOn(plugin, 'saveData');

		await plugin.loadSettings();

		expect(save).not.toHaveBeenCalled();
	});

	it('migrates legacy settings and writes them back once', async () => {
		const {plugin} = makePlugin();
		vi.spyOn(plugin, 'loadData').mockResolvedValue({aiModel: 'llama3', ollamaURL: 'http://h:1'});
		const save = vi.spyOn(plugin, 'saveData');

		await plugin.loadSettings();

		expect(plugin.settings.providers.ollama.chatModel).toBe('llama3');
		expect(plugin.settings.providers.ollama.url).toBe('http://h:1');
		expect(save).toHaveBeenCalledWith(plugin.settings);
	});

	it('saveSettings persists the live settings', async () => {
		const {plugin} = makePlugin();
		await plugin.loadSettings();
		const save = vi.spyOn(plugin, 'saveData');

		await plugin.saveSettings();

		expect(save).toHaveBeenCalledWith(plugin.settings);
	});
});

describe('getModelUserFriendlyName', () => {
	const nameFor = async (provider: ProviderId, model: string) => {
		const {plugin} = makePlugin();
		await plugin.loadSettings();
		plugin.settings.provider = provider;
		plugin.settings.providers[provider].chatModel = model;
		plugin.loadAI();
		return plugin.getModelUserFriendlyName();
	};

	it('falls back to "your model" when none is chosen', async () => {
		expect(await nameFor('ollama', '')).toBe('your model');
	});

	// The name reaches headers and saved-chat filenames, and each backend's ids look different,
	// so the active provider tidies its own: tags, file paths and quantisation, Hugging Face ids.
	it.each([
		['ollama', 'llama3.1:8b', 'Llama3.1'],
		['ollama', 'mistral', 'Mistral'],
		['llamacpp', '/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf', 'Llama-3.2-3B-Instruct'],
		['llamacpp', 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', 'Qwen2.5-7B-Instruct'],
	] as const)('names a %s model %s as %s', async (provider, model, expected) => {
		expect(await nameFor(provider, model)).toBe(expected);
	});

	// llama-server answers as whatever it runs, so that is the model to name.
	it('names the model the llama.cpp server runs, over an older choice', async () => {
		const {plugin} = makePlugin();
		await plugin.loadSettings();
		plugin.settings.provider = 'llamacpp';
		plugin.settings.providers.llamacpp.chatModel = '/models/old-choice.gguf';
		plugin.loadAI();
		(plugin.ai as {runningChatModel: string | null}).runningChatModel = 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M';

		expect(plugin.getModelUserFriendlyName()).toBe('Qwen2.5-7B-Instruct');
	});
});

describe('activateViewInWorkspace', () => {
	it('reuses an existing chat leaf', async () => {
		const existing = makeLeaf();
		const {plugin, app} = makePlugin({leaves: [existing]});

		const leaf = await plugin.activateViewInWorkspace(app.workspace as never);

		expect(leaf).toBe(existing);
		expect(app.workspace.getRightLeaf).not.toHaveBeenCalled();
		expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existing);
	});

	it('opens a new leaf in the right sidebar', async () => {
		const right = makeLeaf();
		const {plugin, app} = makePlugin({rightLeaf: right});

		const leaf = await plugin.activateViewInWorkspace(app.workspace as never);

		expect(leaf).toBe(right);
		expect(right.setViewState).toHaveBeenCalledWith({type: 'mini-rag-chat-window', active: true});
		expect(app.workspace.revealLeaf).toHaveBeenCalledWith(right);
	});

	it('throws when no sidebar leaf is available', async () => {
		const {plugin, app} = makePlugin({rightLeaf: null});

		await expect(plugin.activateViewInWorkspace(app.workspace as never)).rejects.toThrow(
			'could not open a panel in the right sidebar',
		);
	});
});

describe('getChatWindow', () => {
	it('returns the view on an existing leaf', async () => {
		const {plugin, leaves} = makePlugin();
		const view = makeChatWindow(plugin);
		leaves.push(makeLeaf(view));

		expect(await plugin.getChatWindow()).toBe(view);
	});

	it('opens a leaf when none exists', async () => {
		const {plugin, app} = makePlugin();
		const view = makeChatWindow(plugin);
		app.workspace.getRightLeaf.mockReturnValue(makeLeaf(view));

		expect(await plugin.getChatWindow()).toBe(view);
	});

	it('throws when the leaf holds some other view', async () => {
		const {plugin, leaves} = makePlugin();
		leaves.push(makeLeaf({notAChatWindow: true}));

		await expect(plugin.getChatWindow()).rejects.toThrow('unexpected view type');
	});
});

describe('context restore on startup', () => {
	/** Runs onload, installs fakes for the index build, then fires layout-ready. */
	const restore = async (options: {
		path?: string | null;
		type?: 'file' | 'folder' | null;
		withLeaf?: boolean;
		leafView?: 'chat' | 'other';
		addFile?: boolean;
		addFolder?: boolean;
		buildError?: Error;
		buildBumpsSeq?: boolean;
	} = {}) => {
		const harness = makePlugin();
		const {plugin, layoutReady, leaves, files, folders} = harness;
		await plugin.onload();
		plugin.settings.lastContextPath = options.path === undefined ? 'notes/Ideas.md' : options.path;
		plugin.settings.lastContextType = options.type === undefined ? 'file' : options.type;

		const view = makeChatWindow(plugin);
		if (options.withLeaf !== false) {
			leaves.push(makeLeaf(options.leafView === 'other' ? {} : view));
		}
		if (options.addFile !== false) {
			const file = new StubTFile();
			file.path = 'notes/Ideas.md';
			file.basename = 'Ideas';
			files.set('notes/Ideas.md', file);
		}
		if (options.addFolder) {
			const folder = new StubTFolder();
			folder.path = 'notes';
			folder.name = 'notes';
			folders.set('notes', folder);
		}

		const context = {
			addFileToContext: vi.fn(async () => {}),
			addFolderToContext: vi.fn(async () => {}),
			buildIndex: vi.fn(async () => {
				if (options.buildBumpsSeq) plugin.contextLoadSeq++;
				if (options.buildError) throw options.buildError;
			}),
		};
		plugin.context = context as never;

		layoutReady[0]();
		await new Promise(resolve => setTimeout(resolve, 0));
		return {...harness, view, context};
	};

	it('does nothing when no context was remembered', async () => {
		const {context} = await restore({path: null, type: null});

		expect(context.addFileToContext).not.toHaveBeenCalled();
	});

	it('does nothing when the chat panel is not open', async () => {
		const {context} = await restore({withLeaf: false});

		expect(context.addFileToContext).not.toHaveBeenCalled();
	});

	it('does nothing when the leaf holds some other view', async () => {
		const {context} = await restore({leafView: 'other'});

		expect(context.addFileToContext).not.toHaveBeenCalled();
	});

	it('restores a remembered file, titling the chat with it, and indexes', async () => {
		const {context, view} = await restore();

		expect(context.addFileToContext).toHaveBeenCalled();
		expect(view.resetChat).toHaveBeenCalledWith('Ideas');
		expect(context.buildIndex).toHaveBeenCalled();
		expect(vi.mocked(view.setAwaitingResponse).mock.calls).toEqual([[true], [false]]);
	});

	it('restores a remembered folder', async () => {
		const {context, view} = await restore({path: 'notes', type: 'folder', addFolder: true});

		expect(context.addFolderToContext).toHaveBeenCalled();
		expect(view.resetChat).toHaveBeenCalledWith('notes');
	});

	it('reports a remembered file that has since been deleted', async () => {
		const {context} = await restore({addFile: false});

		expect(notices).toContain('Mini-RAG: context file not found — "notes/Ideas.md"');
		expect(context.buildIndex).not.toHaveBeenCalled();
	});

	it('reports a remembered folder that has since been deleted', async () => {
		await restore({path: 'gone', type: 'folder'});

		expect(notices).toContain('Mini-RAG: context folder not found — "gone"');
	});

	it('reports a failed index build through the shared handler', async () => {
		const {view} = await restore({buildError: new Error('embed failed')});

		expect(notices).toContain('Mini-RAG: failed to build index — embed failed');
		expect(view.setAwaitingResponse).toHaveBeenLastCalledWith(false);
	});

	it('shows the install panel when a dedicated embedding model fails', async () => {
		const harness = makePlugin();
		await harness.plugin.loadSettings();
		harness.plugin.settings.providers.ollama.dedicatedEmbeddingEnabled = true;
		harness.plugin.settings.providers.ollama.embeddingModel = 'bge-m3';
		harness.plugin.loadAI();
		const view = makeChatWindow(harness.plugin);

		harness.plugin.indexBuildErrorDeps(view).showIndexError('bge-m3');

		expect(view.showIndexError).toHaveBeenCalledWith('bge-m3');
	});

	// A context menu click during a slow startup restore takes over the panel.
	it('leaves the panel alone if a newer load started during indexing', async () => {
		const {view} = await restore({buildBumpsSeq: true, buildError: new Error('late')});

		expect(notices).toEqual([]);
		expect(vi.mocked(view.setAwaitingResponse).mock.calls).toEqual([[true]]);
	});

	it('leaves the panel alone if a newer load started while reading files', async () => {
		const harness = makePlugin();
		const {plugin, layoutReady, leaves, files} = harness;
		await plugin.onload();
		plugin.settings.lastContextPath = 'notes/Ideas.md';
		plugin.settings.lastContextType = 'file';
		const view = makeChatWindow(plugin);
		leaves.push(makeLeaf(view));
		const file = new StubTFile();
		file.path = 'notes/Ideas.md';
		files.set('notes/Ideas.md', file);
		const buildIndex = vi.fn();
		plugin.context = {
			addFileToContext: vi.fn(async () => {
				plugin.contextLoadSeq++;
			}),
			buildIndex,
		} as never;

		layoutReady[0]();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(buildIndex).not.toHaveBeenCalled();
	});
});

describe('onunload', () => {
	it('aborts and disposes the provider', async () => {
		const {plugin} = makePlugin();
		const dispose = vi.fn(async () => {});
		plugin.ai = {abort: vi.fn(), dispose} as never;

		plugin.onunload();

		expect(plugin.ai.abort).toHaveBeenCalled();
		expect(dispose).toHaveBeenCalled();
	});

	it('tolerates a provider without dispose, and no provider at all', () => {
		const {plugin} = makePlugin();

		expect(() => plugin.onunload()).not.toThrow();
		plugin.ai = {abort: vi.fn()} as never;
		expect(() => plugin.onunload()).not.toThrow();
	});
});

describe('saving chats', () => {
	const setup = async () => {
		const harness = makePlugin();
		await harness.plugin.onload();
		const view = makeChatWindow(harness.plugin);
		return {...harness, view};
	};

	it('creates the chats folder only when it is missing', async () => {
		const {plugin, app, folders} = await setup();

		await plugin.ensureChatFolder();
		expect(app.vault.createFolder).toHaveBeenCalledWith('Mini-RAG Chats');

		app.vault.createFolder.mockClear();
		folders.set('Mini-RAG Chats', new StubTFolder());
		await plugin.ensureChatFolder();
		expect(app.vault.createFolder).not.toHaveBeenCalled();
	});

	it('writes the chat as markdown and remembers where', async () => {
		const {plugin, app, view} = await setup();
		plugin.settings.providers.ollama.chatModel = 'llama3';

		await plugin.writeChatToFile(view, 'Mini-RAG Chats/x.md');

		const [path, content] = app.vault.create.mock.calls[0] as unknown as [string, string];
		expect(path).toBe('Mini-RAG Chats/x.md');
		expect(content).toContain('type: mini-rag-chat');
		expect(content).toContain('model: llama3');
		expect(view.savedChatPath).toBe('Mini-RAG Chats/x.md');
	});

	it('records the model the llama.cpp server ran, over an older choice', async () => {
		const {plugin, app, view} = await setup();
		plugin.settings.provider = 'llamacpp';
		plugin.settings.providers.llamacpp.chatModel = '/models/old-choice.gguf';
		plugin.loadAI();
		(plugin.ai as {runningChatModel: string | null}).runningChatModel = 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M';

		await plugin.writeChatToFile(view, 'Mini-RAG Chats/x.md');

		const [, content] = app.vault.create.mock.calls[0] as unknown as [string, string];
		// Quoted, since the id contains a colon.
		expect(content).toContain('model: "bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"');
	});

	it('refuses to save an empty chat', async () => {
		const {plugin, view} = await setup();

		await plugin.saveChat(view);

		expect(notices).toContain('Nothing to save — start a conversation first.');
	});

	describe('with messages', () => {
		const withMessages = async () => {
			const harness = await setup();
			harness.view.chatMessages = {
				get: vi.fn(() => [{role: 'user', content: 'hi', timestamp: 't'}]),
			} as never;
			return harness;
		};

		it('saves a new chat under a timestamped name', async () => {
			const {plugin, view} = await withMessages();

			await plugin.saveChat(view);

			// No model configured, so the name falls back to the uncapitalised "your model".
			expect(notices).toContain('Chat saved: Mini-RAG Chats/2026-09-10 14-30-45 - Chat with your model.md');
		});

		it('updates the same file on a second save', async () => {
			const {plugin, view} = await withMessages();
			view.savedChatPath = 'Mini-RAG Chats/existing.md';

			await plugin.saveChat(view);

			expect(notices).toContain('Chat updated: Mini-RAG Chats/existing.md');
		});

		it('opens the Save-as dialog instead of writing', async () => {
			const {plugin, view, app} = await withMessages();
			const open = vi.spyOn(SaveChatAsModal.prototype, 'open').mockImplementation(() => {});

			await plugin.saveChat(view, true);

			expect(open).toHaveBeenCalled();
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it('reports a failed save', async () => {
			const {plugin, view, app} = await withMessages();
			app.vault.create.mockRejectedValueOnce(new Error('read-only vault'));

			await plugin.saveChat(view);

			expect(notices).toContain('Mini-RAG: failed to save chat. read-only vault');
		});
	});
});

// A model or provider chosen in the settings must reach a chat panel that is already open, or
// its header goes on naming the old model.
describe('notifyChatModelChanged', () => {
	it('updates every open chat panel', async () => {
		const {plugin, leaves} = makePlugin();
		await plugin.onload();
		const view = makeChatWindow(plugin);
		const modelChanged = vi.spyOn(view, 'modelChanged').mockImplementation(() => {});
		leaves.push(makeLeaf(view));

		plugin.notifyChatModelChanged();

		expect(modelChanged).toHaveBeenCalledTimes(1);
	});

	// The new model never saw the conversation so far.
	it('starts the conversation afresh', async () => {
		const {plugin} = makePlugin();
		await plugin.onload();
		const clearContext = vi.spyOn(plugin.ai, 'clearContext');

		plugin.notifyChatModelChanged();

		expect(clearContext).toHaveBeenCalledTimes(1);
	});

	it('passes over leaves that are not chat panels', async () => {
		const {plugin, leaves} = makePlugin();
		await plugin.onload();
		leaves.push(makeLeaf({}));

		expect(() => plugin.notifyChatModelChanged()).not.toThrow();
	});
});
