/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
	__resetMenus,
	__resetNotices,
	Component,
	MarkdownRenderer,
	menus,
	notices,
} from '../stubs/obsidian';
import type {Component as ObsidianComponent} from 'obsidian';
import {clipboard} from '../stubs/electron';
import {ChatConversationWindow} from '../../src/classes/ui/chat-conversation-window';
import {CSS_CLASS_PREFIX} from '../../src/constants';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings} from '../../src/types';
import MiniRagPlugin from '../../main';
import {click, makeContainer} from '../helpers/ui';

interface SetupOptions {
	models?: string[];
	modelListError?: boolean;
	settings?: Partial<PluginSettings>;
}

function setup(options: SetupOptions = {}) {
	const settings: PluginSettings = {...defaultSettings(), ...options.settings};
	settings.providers.ollama.chatModel = settings.providers.ollama.chatModel || 'llama3';

	const ai = {
		getModelList: vi.fn(async () => {
			if (options.modelListError) throw new Error('unreachable');
			return options.models ?? ['llama3', 'mistral'];
		}),
		clearContext: vi.fn(),
	};

	const plugin = {
		settings,
		ai,
		app: {},
		saveSettings: vi.fn(async () => {}),
		getModelUserFriendlyName: () => {
			const model = settings.providers.ollama.chatModel;
			return model ? model.charAt(0).toUpperCase() + model.slice(1) : 'your model';
		},
	} as unknown as MiniRagPlugin;

	const parent = makeContainer();
	// Cast for the same stub-vs-real-typings reason as elsewhere: vitest aliases the obsidian
	// module to the stub at runtime, while tsc resolves it to the published types.
	const renderComponent = new Component();
	const window = new ChatConversationWindow(
		plugin,
		parent,
		renderComponent as unknown as ObsidianComponent,
	);

	return {window, plugin, ai, settings, parent, renderComponent};
}

/** Lets the constructor's fire-and-forget fetchModels() settle. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
	__resetMenus();
	__resetNotices();
	clipboard.writeText.mockClear();
	MarkdownRenderer.render.mockClear();
});

describe('construction', () => {
	it('creates a header and a conversation area', () => {
		const {window, parent} = setup();

		expect(window.headerEl.classList.contains(`${CSS_CLASS_PREFIX}chat-header`)).toBe(true);
		expect(window.htmlElement.classList.contains(`${CSS_CLASS_PREFIX}conversation`)).toBe(true);
		expect(parent.contains(window.headerEl)).toBe(true);
	});

	// Per-message listeners live on a child component so clear() can drop them all at once.
	it('registers a child component to own message listeners', () => {
		const {renderComponent} = setup();

		expect(renderComponent.children).toHaveLength(1);
	});

	it('names the current model in the heading', () => {
		const {window} = setup();

		expect(window.headerEl.textContent).toContain('Chat with Llama3');
	});

	it('reports a context-free chat by default', () => {
		const {window} = setup();

		expect(window.headerEl.textContent).toContain('Context-Free');
	});
});

describe('addConvoHeading', () => {
	it('names the context subject when given one', () => {
		const {window} = setup();

		window.addConvoHeading('Projects');

		expect(window.headerEl.textContent).toContain('Context: Projects');
		expect(window.headerEl.textContent).not.toContain('Context-Free');
	});

	// Rebuilt from scratch each time, so headings must not stack up.
	it('replaces the previous heading rather than appending', () => {
		const {window} = setup();

		window.addConvoHeading('First');
		window.addConvoHeading('Second');

		expect(window.headerEl.textContent).toContain('Second');
		expect(window.headerEl.textContent).not.toContain('First');
		expect(window.headerEl.querySelectorAll('h3')).toHaveLength(1);
	});

	it('fetches the model list', async () => {
		const {ai} = setup();
		await settle();

		expect(ai.getModelList).toHaveBeenCalled();
	});

	it('survives an unreachable server while fetching models', async () => {
		const {window} = setup({modelListError: true});
		await settle();

		expect(window.headerEl.textContent).toContain('Chat with');
	});
});

describe('model selector', () => {
	const chevron = (window: ChatConversationWindow) =>
		window.headerEl.querySelector('button') as HTMLButtonElement;

	// Obsidian draws its tooltip from aria-label; a title would add the browser's as well.
	it('labels the chevron, with one tooltip', () => {
		const {window} = setup();

		expect(chevron(window).getAttribute('aria-label')).toBe('Change model');
		expect(chevron(window).hasAttribute('title')).toBe(false);
	});

	it('lists every available model', async () => {
		const {window} = setup({models: ['llama3', 'mistral', 'qwen']});
		await settle();

		click(chevron(window));
		await settle();

		expect(menus[0].items.map(i => i.title)).toEqual(['llama3', 'mistral', 'qwen']);
	});

	it('ticks the model currently in use', async () => {
		const {window} = setup({models: ['llama3', 'mistral']});
		await settle();

		click(chevron(window));
		await settle();

		expect(menus[0].item('llama3')?.icon).toBe('check');
		expect(menus[0].item('mistral')?.icon).toBe('');
	});

	it('offers a disabled placeholder when no models are found', async () => {
		const {window} = setup({models: []});
		await settle();

		click(chevron(window));
		await settle();

		expect(menus[0].items).toHaveLength(1);
		expect(menus[0].items[0].title).toBe('No models found');
		expect(menus[0].items[0].disabled).toBe(true);
	});

	it('re-fetches the list each time it opens, so a newly pulled model appears', async () => {
		const {window, ai} = setup();
		await settle();
		ai.getModelList.mockClear();

		click(chevron(window));
		await settle();

		expect(ai.getModelList).toHaveBeenCalledTimes(1);
	});

	describe('choosing a model', () => {
		const choose = async (model: string) => {
			const harness = setup({models: ['llama3', 'mistral']});
			await settle();
			click(chevron(harness.window));
			await settle();
			await menus[0].item(model)?.click();
			return harness;
		};

		it('writes the choice to the active provider config', async () => {
			const {settings} = await choose('mistral');

			expect(settings.providers.ollama.chatModel).toBe('mistral');
		});

		it('persists the choice', async () => {
			const {plugin} = await choose('mistral');

			expect(plugin.saveSettings).toHaveBeenCalled();
		});

		// A new model has no idea what the previous one was told, so the history must be dropped.
		it('clears the conversation context', async () => {
			const {ai} = await choose('mistral');

			expect(ai.clearContext).toHaveBeenCalledTimes(1);
		});

		it('updates the heading to the new model', async () => {
			const {window} = await choose('mistral');

			expect(window.headerEl.textContent).toContain('Chat with Mistral');
		});

		it('marks the switch in the transcript', async () => {
			const {window} = await choose('mistral');

			const divider = window.htmlElement.querySelector(`.${CSS_CLASS_PREFIX}model-switch-divider`);
			expect(divider?.textContent).toContain('switched to Mistral');
		});
	});

	// Its list belongs to the provider that gave it; a failed refresh must not fall back on another's.
	it('does not offer another provider\'s models when the new one cannot be reached', async () => {
		const {window, plugin} = setup({models: ['llama3', 'mistral']});
		await settle();
		(plugin as unknown as {ai: unknown}).ai = {
			getModelList: vi.fn(async () => {
				throw new Error('unreachable');
			}),
			clearContext: vi.fn(),
		};

		click(chevron(window));
		await settle();

		expect(menus[0].items.map(i => i.title)).toEqual(['Could not load models']);
		expect(menus[0].items[0].disabled).toBe(true);
	});

	it('keeps its own list when a refresh fails', async () => {
		const {window, ai} = setup({models: ['llama3', 'mistral']});
		await settle();
		ai.getModelList.mockRejectedValueOnce(new Error('unreachable'));

		click(chevron(window));
		await settle();

		expect(menus[0].items.map(i => i.title)).toEqual(['llama3', 'mistral']);
	});

	it('disables and re-enables the chevron', () => {
		const {window} = setup();

		window.setModelSelectorEnabled(false);
		expect(chevron(window).disabled).toBe(true);

		window.setModelSelectorEnabled(true);
		expect(chevron(window).disabled).toBe(false);
	});
});

describe('addToConversation', () => {
	const boxes = (window: ChatConversationWindow) =>
		Array.from(window.htmlElement.querySelectorAll(`.${CSS_CLASS_PREFIX}convo-box`));

	it('renders a user message as plain text', () => {
		const {window} = setup();

		window.addToConversation('my question', false);

		const box = boxes(window)[0];
		expect(box.textContent).toBe('my question');
		expect(box.classList.contains(`${CSS_CLASS_PREFIX}query`)).toBe(true);
		// Plain text, so a question containing markdown is shown verbatim.
		expect(MarkdownRenderer.render).not.toHaveBeenCalled();
	});

	it('renders an assistant message as markdown', () => {
		const {window, plugin} = setup();

		window.addToConversation('**bold**', true);

		const box = boxes(window)[0];
		expect(box.classList.contains(`${CSS_CLASS_PREFIX}response`)).toBe(true);
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(plugin.app, '**bold**', box, '', expect.anything());
	});

	// The empty source path stops AI output resolving [[wikilinks]] against real vault files.
	it('renders markdown with an empty source path', () => {
		const {window} = setup();

		window.addToConversation('see [[Note]]', true);

		expect(MarkdownRenderer.render.mock.calls[0]).toEqual([
			expect.anything(), 'see [[Note]]', expect.anything(), '', expect.anything(),
		]);
	});

	it('appends messages in order', () => {
		const {window} = setup();

		window.addToConversation('first', false);
		window.addToConversation('second', true);

		expect(boxes(window)).toHaveLength(2);
	});

	describe('copy on click', () => {
		it('copies a user message', () => {
			const {window} = setup();
			window.addToConversation('copy me', false);

			click(boxes(window)[0]);

			expect(clipboard.writeText).toHaveBeenCalledWith('copy me');
			expect(notices).toContain('Message copied');
		});

		it('reports a clipboard failure instead of throwing', () => {
			const {window} = setup();
			window.addToConversation('copy me', false);
			clipboard.writeText.mockImplementationOnce(() => {
				throw new Error('no clipboard');
			});

			expect(() => click(boxes(window)[0])).not.toThrow();
			expect(notices).toContain('Could not copy to clipboard.');
		});
	});
});

describe('beginStreamingResponse', () => {
	const streamBox = (window: ChatConversationWindow) =>
		window.htmlElement.querySelector(`.${CSS_CLASS_PREFIX}convo-box-streaming`) as HTMLElement;

	it('creates a streaming response box', () => {
		const {window} = setup();

		window.beginStreamingResponse();

		const box = streamBox(window);
		expect(box).not.toBeNull();
		expect(box.classList.contains(`${CSS_CLASS_PREFIX}response`)).toBe(true);
	});

	it('replaces the text on each append, rather than accumulating', () => {
		const {window} = setup();
		const stream = window.beginStreamingResponse();

		// append receives the cumulative text, so setting rather than adding is correct.
		stream.append('Hel');
		stream.append('Hello');

		expect(streamBox(window).textContent).toBe('Hello');
	});

	it('drops the streaming class and re-renders as markdown on finish', () => {
		const {window} = setup();
		const stream = window.beginStreamingResponse();
		stream.append('**done**');

		stream.finish();

		expect(streamBox(window)).toBeNull();
		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			expect.anything(), '**done**', expect.anything(), '', expect.anything(),
		);
	});

	it('removes the box entirely on remove', () => {
		const {window} = setup();
		const stream = window.beginStreamingResponse();
		stream.append('partial');

		stream.remove();

		expect(window.htmlElement.querySelectorAll(`.${CSS_CLASS_PREFIX}convo-box`)).toHaveLength(0);
	});

	// The click handler is created before any text exists, so it must read through a getter --
	// capturing the value would copy the empty string.
	it('copies the final streamed text, not the empty string it started with', () => {
		const {window} = setup();
		const stream = window.beginStreamingResponse();
		const box = streamBox(window);

		stream.append('the whole answer');
		click(box);

		expect(clipboard.writeText).toHaveBeenCalledWith('the whole answer');
	});

	it('still copies after finish re-renders the box', () => {
		const {window} = setup();
		const stream = window.beginStreamingResponse();
		const box = window.htmlElement.querySelector(`.${CSS_CLASS_PREFIX}convo-box`) as HTMLElement;
		stream.append('final text');

		stream.finish();
		click(box);

		expect(clipboard.writeText).toHaveBeenCalledWith('final text');
	});
});

describe('clear', () => {
	it('empties the transcript', () => {
		const {window} = setup();
		window.addToConversation('a', false);

		window.clear();

		expect(window.htmlElement.children).toHaveLength(0);
	});

	// Stale listeners would otherwise accumulate across chat resets.
	it('swaps in a fresh listener component', () => {
		const {window, renderComponent} = setup();
		const before = renderComponent.children[0];

		window.clear();

		expect(renderComponent.children).toHaveLength(1);
		expect(renderComponent.children[0]).not.toBe(before);
	});

	it('leaves the header intact', () => {
		const {window} = setup();

		window.clear();

		expect(window.headerEl.textContent).toContain('Chat with');
	});
});

describe('addContextNote', () => {
	const note = (parent: HTMLElement) => parent.querySelector(`.${CSS_CLASS_PREFIX}context-note`) as HTMLElement;

	it('adds a note to the transcript', () => {
		const {window, parent} = setup();

		window.addContextNote('Only 1 of 3 notes fit.');

		expect(note(parent).textContent).toBe('Only 1 of 3 notes fit.');
	});

	// It describes the request, so it is not a message: not copied on click, not styled as one.
	it('is not a message', () => {
		const {window, parent} = setup();

		window.addContextNote('Only 1 of 3 notes fit.');
		click(note(parent));

		expect(note(parent).classList.contains(`${CSS_CLASS_PREFIX}convo-box`)).toBe(false);
		expect(clipboard.writeText).not.toHaveBeenCalled();
	});
});

describe('addContextNote placement', () => {
	// The note describes the request, so it belongs above the answer being written to it.
	it('sits above an answer that is still streaming', () => {
		const {window, parent} = setup();
		window.beginStreamingResponse();

		window.addContextNote('Only 1 of 3 notes fit.');

		const note = parent.querySelector(`.${CSS_CLASS_PREFIX}context-note`) as HTMLElement;
		expect(note.nextElementSibling?.classList.contains(`${CSS_CLASS_PREFIX}convo-box-streaming`)).toBe(true);
	});
});

describe('beginProgressNote', () => {
	const notes = (parent: HTMLElement) =>
		Array.from(parent.querySelectorAll(`.${CSS_CLASS_PREFIX}context-note`), el => el.textContent);

	// "Summarizing part 3 of 16…" counts up in one line rather than adding sixteen.
	it('updates one line in place', () => {
		const {window, parent} = setup();

		const progress = window.beginProgressNote('Summarizing part 1 of 3…');
		progress.update('Summarizing part 2 of 3…');

		expect(notes(parent)).toEqual(['Summarizing part 2 of 3…']);
	});

	it('sits above an answer that is still streaming', () => {
		const {window, parent} = setup();
		window.beginStreamingResponse();

		window.beginProgressNote('Summarizing part 1 of 3…');

		const note = parent.querySelector(`.${CSS_CLASS_PREFIX}context-note`) as HTMLElement;
		expect(note.nextElementSibling?.classList.contains(`${CSS_CLASS_PREFIX}convo-box-streaming`)).toBe(true);
	});
});

// The model changed in the settings rather than from this pane's own menu.
describe('modelChanged', () => {
	const changeTo = async (model: string) => {
		const harness = setup({models: ['llama3', 'mistral']});
		await settle();
		harness.settings.providers.ollama.chatModel = model;
		harness.ai.getModelList.mockClear();
		harness.window.modelChanged();
		await settle();
		return harness;
	};

	it('names the new model in the heading', async () => {
		const {window} = await changeTo('mistral');

		expect(window.headerEl.textContent).toContain('Chat with Mistral');
	});

	it('marks the switch in the transcript', async () => {
		const {window} = await changeTo('mistral');

		const divider = window.htmlElement.querySelector(`.${CSS_CLASS_PREFIX}model-switch-divider`);
		expect(divider?.textContent).toContain('switched to Mistral');
	});

	it('lists the models afresh', async () => {
		const {ai} = await changeTo('mistral');

		expect(ai.getModelList).toHaveBeenCalledTimes(1);
	});
});

// Where the server decides the model, the name is only certain once it has answered.
describe('naming the model in use', () => {
	it('renames the heading once the model list arrives', async () => {
		const harness = setup({models: ['llama3']});
		await settle();
		let finish: (models: string[]) => void = () => {};
		harness.ai.getModelList.mockImplementationOnce(() => new Promise(resolve => {
			finish = resolve;
		}));
		harness.window.addConvoHeading();
		expect(harness.window.headerEl.textContent).toContain('Chat with Llama3');

		harness.settings.providers.ollama.chatModel = 'mistral';
		finish(['mistral']);
		await settle();

		expect(harness.window.headerEl.textContent).toContain('Chat with Mistral');
	});
});
