import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
	__resetMenus,
	__resetNotices,
	Menu,
	notices,
	TFile as StubTFile,
	TFolder as StubTFolder,
} from './stubs/obsidian';
import type {Menu as ObsidianMenu, TAbstractFile} from 'obsidian';
import {MenuManager} from '../src/classes/menu-manager';
import {defaultSettings} from '../src/defaults';
import {PluginSettings} from '../src/types';
import MiniRagPlugin from '../main';

function makeFile(path: string): TAbstractFile {
	const file = new StubTFile();
	file.path = path;
	file.name = path.split('/').pop() ?? path;
	return file as unknown as TAbstractFile;
}

function makeFolder(path: string): TAbstractFile {
	const folder = new StubTFolder();
	folder.path = path;
	folder.name = path.split('/').pop() ?? path;
	return folder as unknown as TAbstractFile;
}

interface SetupOptions {
	chatModel?: string;
	contextFree?: boolean;
	activateFails?: boolean;
	buildFails?: boolean;
}

function setup(options: SetupOptions = {}) {
	const settings: PluginSettings = defaultSettings();
	settings.providers.ollama.chatModel = options.chatModel ?? 'llama3';
	settings.isContextFreeChatsEnabled = options.contextFree ?? false;

	const handlers: Record<string, (...args: unknown[]) => void> = {};
	const chatWindow = {
		resetChat: vi.fn(),
		setAwaitingResponse: vi.fn(),
	};
	const deps = {notify: vi.fn()};

	const plugin = {
		settings,
		contextLoadSeq: 0,
		app: {
			workspace: {
				on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
					handlers[name] = handler;
					return {name};
				}),
			},
		},
		registerEvent: vi.fn(),
		saveSettings: vi.fn(async () => {}),
		activateViewInWorkspace: vi.fn(async () => {
			if (options.activateFails) throw new Error('no sidebar');
		}),
		getChatWindow: vi.fn(async () => chatWindow),
		loadAI: vi.fn(),
		loadContextualizer: vi.fn(),
		ai: {abort: vi.fn()},
		context: {
			addFileToContext: vi.fn(async () => {}),
			addFolderToContext: vi.fn(async () => {}),
			buildIndex: vi.fn(async () => {
				if (options.buildFails) throw new Error('embed failed');
			}),
		},
		fileManager: {
			readFilenameWithoutExtension: (file: TAbstractFile) => file.name.replace(/\.md$/, ''),
		},
		// A real deps object would route through handleIndexBuildError; notify is what it calls
		// for an ordinary failure with no dedicated embedding model.
		indexBuildErrorDeps: vi.fn(() => ({
			dedicated: false,
			embeddingModel: 'm',
			showIndexError: vi.fn(),
			notify: deps.notify,
			formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
		})),
	};

	const manager = new MenuManager(plugin as unknown as MiniRagPlugin);
	return {manager, plugin, handlers, chatWindow, deps, settings};
}

const newMenu = () => new Menu() as unknown as ObsidianMenu & Menu;

beforeEach(() => {
	__resetMenus();
	__resetNotices();
});

describe('registration', () => {
	it('registers editor and file-navigator context menus', () => {
		const {plugin, handlers} = setup();

		expect(Object.keys(handlers).sort()).toEqual(['editor-menu', 'file-menu']);
		expect(plugin.registerEvent).toHaveBeenCalledTimes(2);
	});
});

describe('menu titles', () => {
	it('names the context file', () => {
		expect(setup().manager.getMenuTitleOfItem('Ideas')).toBe('Open Mini-RAG chat (context: "Ideas")');
	});

	it('marks a context-free chat', () => {
		expect(setup().manager.getMenuTitleOfItem()).toBe('Open Mini-RAG chat (context-free)');
	});
});

describe('which items appear', () => {
	// Items stay hidden until a model is chosen, since a chat could not answer without one.
	it('adds nothing when no chat model is selected', () => {
		const {handlers} = setup({chatModel: '', contextFree: true});
		const menu = newMenu();

		handlers['file-menu'](menu, makeFile('a.md'));

		expect(menu.items).toEqual([]);
	});

	it('adds a context item for a file in the navigator', () => {
		const {handlers} = setup();
		const menu = newMenu();

		handlers['file-menu'](menu, makeFile('notes/Ideas.md'));

		expect(menu.items.map(i => i.title)).toEqual(['Open Mini-RAG chat (context: "Ideas")']);
		expect(menu.items[0].icon).toBe('brain');
	});

	it('adds a context item for a folder', () => {
		const {handlers} = setup();
		const menu = newMenu();

		handlers['file-menu'](menu, makeFolder('notes'));

		expect(menu.items.map(i => i.title)).toEqual(['Open Mini-RAG chat (context: "notes")']);
	});

	// The vault root as context would index everything.
	it('adds no context item for the vault root', () => {
		const {handlers} = setup();
		const menu = newMenu();

		handlers['file-menu'](menu, makeFolder(''));

		expect(menu.items).toEqual([]);
	});

	it('adds the context-free item only when enabled', () => {
		const disabled = setup({contextFree: false});
		const menuA = newMenu();
		disabled.handlers['file-menu'](menuA, makeFile('a.md'));
		expect(menuA.items.map(i => i.title)).not.toContain('Open Mini-RAG chat (context-free)');

		const enabled = setup({contextFree: true});
		const menuB = newMenu();
		enabled.handlers['file-menu'](menuB, makeFile('a.md'));
		expect(menuB.items.map(i => i.title)).toContain('Open Mini-RAG chat (context-free)');
	});

	it('adds context and context-free items in the editor menu', () => {
		const {handlers} = setup({contextFree: true});
		const menu = newMenu();

		handlers['editor-menu'](menu, {}, {file: makeFile('a.md')});

		expect(menu.items).toHaveLength(2);
	});

	it('adds only the context-free item in an editor with no file', () => {
		const {handlers} = setup({contextFree: true});
		const menu = newMenu();

		handlers['editor-menu'](menu, {}, {file: null});

		expect(menu.items.map(i => i.title)).toEqual(['Open Mini-RAG chat (context-free)']);
	});
});

describe('opening a context chat', () => {
	const openFor = async (target: TAbstractFile, options: SetupOptions = {}) => {
		const harness = setup(options);
		const menu = newMenu();
		harness.handlers['file-menu'](menu, target);
		await menu.items[0].click();
		return harness;
	};

	it('remembers a file context so it can be restored on restart', async () => {
		const {settings, plugin} = await openFor(makeFile('notes/Ideas.md'));

		expect(settings.lastContextPath).toBe('notes/Ideas.md');
		expect(settings.lastContextType).toBe('file');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('remembers a folder context', async () => {
		const {settings} = await openFor(makeFolder('notes'));

		expect(settings.lastContextType).toBe('folder');
	});

	it('loads a file into a fresh contextualizer', async () => {
		const {plugin} = await openFor(makeFile('a.md'));

		expect(plugin.loadContextualizer).toHaveBeenCalled();
		expect(plugin.context.addFileToContext).toHaveBeenCalled();
		expect(plugin.context.addFolderToContext).not.toHaveBeenCalled();
	});

	it('loads a folder recursively', async () => {
		const {plugin} = await openFor(makeFolder('notes'));

		expect(plugin.context.addFolderToContext).toHaveBeenCalled();
	});

	// A fresh provider is how conversation history is reset for the new context.
	it('replaces the provider, aborting any in-flight answer first', async () => {
		const {plugin} = await openFor(makeFile('a.md'));

		expect(plugin.ai.abort).toHaveBeenCalled();
		expect(plugin.loadAI).toHaveBeenCalled();
	});

	it('resets the chat, titled with the context, and builds the index', async () => {
		const {plugin, chatWindow} = await openFor(makeFile('a.md'));

		expect(chatWindow.resetChat).toHaveBeenCalledWith('a');
		expect(plugin.context.buildIndex).toHaveBeenCalled();
	});

	it('locks the input while indexing and unlocks it after', async () => {
		const {chatWindow} = await openFor(makeFile('a.md'));

		expect(chatWindow.setAwaitingResponse.mock.calls).toEqual([[true], [false]]);
	});

	it('reports a failed index build through the shared handler, and still unlocks', async () => {
		const {deps, chatWindow} = await openFor(makeFile('a.md'), {buildFails: true});

		expect(deps.notify).toHaveBeenCalledWith('Mini-RAG: failed to build index — embed failed');
		expect(chatWindow.setAwaitingResponse).toHaveBeenLastCalledWith(false);
	});

	it('gives up with a notice when the panel cannot be opened', async () => {
		const {plugin} = await openFor(makeFile('a.md'), {activateFails: true});

		expect(notices).toContain('Mini-RAG: could not open the chat panel.');
		expect(plugin.context.addFileToContext).not.toHaveBeenCalled();
	});

	describe('superseded loads', () => {
		// Each click stamps a sequence number; a newer click makes an older handler bail out
		// after its next await, so two loads cannot both write to the panel.
		it('stops after saving if another load started', async () => {
			const harness = setup();
			harness.plugin.saveSettings.mockImplementationOnce(async () => {
				harness.plugin.contextLoadSeq++;
			});
			const menu = newMenu();
			harness.handlers['file-menu'](menu, makeFile('a.md'));

			await menu.items[0].click();

			expect(harness.plugin.activateViewInWorkspace).not.toHaveBeenCalled();
		});

		it('stops after opening the panel if another load started', async () => {
			const harness = setup();
			harness.plugin.activateViewInWorkspace.mockImplementationOnce(async () => {
				harness.plugin.contextLoadSeq++;
			});
			const menu = newMenu();
			harness.handlers['file-menu'](menu, makeFile('a.md'));

			await menu.items[0].click();

			expect(harness.plugin.context.addFileToContext).not.toHaveBeenCalled();
		});

		it('stops before touching the chat if another load started while reading files', async () => {
			const harness = setup();
			harness.plugin.context.addFileToContext.mockImplementationOnce(async () => {
				harness.plugin.contextLoadSeq++;
			});
			const menu = newMenu();
			harness.handlers['file-menu'](menu, makeFile('a.md'));

			await menu.items[0].click();

			expect(harness.chatWindow.resetChat).not.toHaveBeenCalled();
		});

		it('leaves the lock to the newer load if superseded during indexing', async () => {
			const harness = setup();
			harness.plugin.context.buildIndex.mockImplementationOnce(async () => {
				harness.plugin.contextLoadSeq++;
			});
			const menu = newMenu();
			harness.handlers['file-menu'](menu, makeFile('a.md'));

			await menu.items[0].click();

			expect(harness.chatWindow.setAwaitingResponse.mock.calls).toEqual([[true]]);
		});
	});
});

describe('opening a context-free chat', () => {
	const openFree = async (options: SetupOptions = {}) => {
		const harness = setup({contextFree: true, ...options});
		const menu = newMenu();
		harness.handlers['editor-menu'](menu, {}, {file: null});
		await menu.items[0].click();
		return harness;
	};

	it('forgets any remembered context', async () => {
		const harness = setup({contextFree: true});
		harness.settings.lastContextPath = 'a.md';
		harness.settings.lastContextType = 'file';
		const menu = newMenu();
		harness.handlers['editor-menu'](menu, {}, {file: null});

		await menu.items[0].click();

		expect(harness.settings.lastContextPath).toBeNull();
		expect(harness.settings.lastContextType).toBeNull();
		expect(harness.plugin.saveSettings).toHaveBeenCalled();
	});

	it('supersedes any in-flight context load', async () => {
		const {plugin} = await openFree();

		expect(plugin.contextLoadSeq).toBe(1);
	});

	it('resets the provider and the chat, with no subject', async () => {
		const {plugin, chatWindow} = await openFree();

		expect(plugin.ai.abort).toHaveBeenCalled();
		expect(plugin.loadAI).toHaveBeenCalled();
		expect(chatWindow.resetChat).toHaveBeenCalledWith();
	});

	it('gives up with a notice when the panel cannot be opened', async () => {
		const {plugin} = await openFree({activateFails: true});

		expect(notices).toContain('Mini-RAG: could not open the chat panel.');
		expect(plugin.loadAI).not.toHaveBeenCalled();
	});
});
