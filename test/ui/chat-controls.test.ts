/**
 * @vitest-environment jsdom
 *
 * jsdom is opted into per file rather than globally: the streaming tests need Node's
 * ReadableStream, which the jsdom environment does not provide.
 */
import '../setup/obsidian-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetMenus, menus} from '../stubs/obsidian';
import {ChatLoadingAnimation} from '../../src/classes/ui/chat-loading-animation';
import {ChatInput} from '../../src/classes/ui/chat-input';
import {ChatButtons} from '../../src/classes/ui/chat-buttons';
import {CSS_CLASS_PREFIX} from '../../src/constants';
import {click, FakeChatWindow, flush, keydown, makeContainer} from '../helpers/ui';

beforeEach(() => {
	__resetMenus();
});

describe('ChatLoadingAnimation', () => {
	it('creates a hidden loader span in its parent', () => {
		const parent = makeContainer();

		const loader = new ChatLoadingAnimation(parent);

		expect(loader.htmlElement.tagName).toBe('SPAN');
		expect(loader.htmlElement.parentElement).toBe(parent);
		expect(loader.htmlElement.classList.contains(`${CSS_CLASS_PREFIX}loader`)).toBe(true);
		expect(loader.htmlElement.classList.contains('hidden')).toBe(true);
	});

	it('shows and hides', () => {
		const loader = new ChatLoadingAnimation(makeContainer());

		loader.show();
		expect(loader.htmlElement.classList.contains('hidden')).toBe(false);

		loader.hide();
		expect(loader.htmlElement.classList.contains('hidden')).toBe(true);
	});

	it('is idempotent', () => {
		const loader = new ChatLoadingAnimation(makeContainer());

		loader.show();
		loader.show();
		loader.hide();
		loader.hide();

		expect(loader.htmlElement.classList.contains('hidden')).toBe(true);
	});
});

describe('ChatInput', () => {
	const setup = () => {
		const host = new FakeChatWindow();
		const input = new ChatInput(host.asChatWindow());
		input.init();
		return {host, input};
	};

	it('creates a textarea with a placeholder', () => {
		const {host, input} = setup();

		expect(input.htmlElement.tagName).toBe('TEXTAREA');
		expect(input.htmlElement.getAttribute('placeholder')).toBe('Type your question here');
		expect(input.htmlElement.parentElement).toBe(host.inputWrapper);
	});

	it('reads and writes its value', () => {
		const {input} = setup();

		input.setValue('hello');
		expect(input.getValue()).toBe('hello');

		input.clear();
		expect(input.getValue()).toBe('');
	});

	it('starts able to send', () => {
		expect(setup().input.canSend()).toBe(true);
	});

	it('tracks the send-enabled flag', () => {
		const {input} = setup();

		input.setSendEnabled(false);
		expect(input.canSend()).toBe(false);

		input.setSendEnabled(true);
		expect(input.canSend()).toBe(true);
	});

	describe('Enter handling', () => {
		it('sends on Enter and suppresses the newline', async () => {
			const {host, input} = setup();

			const event = keydown(input.htmlElement, 'Enter');
			await flush();

			expect(host.sendInputAsChatMessage).toHaveBeenCalledTimes(1);
			expect(event.defaultPrevented).toBe(true);
		});

		// Shift+Enter is how a user writes a multi-line question.
		it('does not send on Shift+Enter, and leaves the newline alone', async () => {
			const {host, input} = setup();

			const event = keydown(input.htmlElement, 'Enter', {shiftKey: true});
			await flush();

			expect(host.sendInputAsChatMessage).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
		});

		it('ignores other keys', async () => {
			const {host, input} = setup();

			keydown(input.htmlElement, 'a');
			await flush();

			expect(host.sendInputAsChatMessage).not.toHaveBeenCalled();
		});

		// Still swallows the newline while a response streams, so the box does not grow.
		it('suppresses the newline but does not send while sending is disabled', async () => {
			const {host, input} = setup();
			input.setSendEnabled(false);

			const event = keydown(input.htmlElement, 'Enter');
			await flush();

			expect(host.sendInputAsChatMessage).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(true);
		});
	});

	describe('focusIfActiveView', () => {
		it('focuses when the chat panel is the active view', () => {
			const host = new FakeChatWindow();
			const input = new ChatInput(host.asChatWindow());
			input.init();
			// getActiveViewOfType must return this very window for the focus to apply.
			host.app.workspace.getActiveViewOfType = () => host;
			const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
				.mockImplementation(cb => {
					cb(0);
					return 0;
				});
			const focus = vi.spyOn(input.htmlElement, 'focus');

			input.focusIfActiveView();

			expect(focus).toHaveBeenCalled();
			raf.mockRestore();
		});

		it('does nothing when another view is active', () => {
			const host = new FakeChatWindow({activeView: {other: true}});
			const input = new ChatInput(host.asChatWindow());
			input.init();
			const raf = vi.spyOn(globalThis, 'requestAnimationFrame');

			input.focusIfActiveView();

			expect(raf).not.toHaveBeenCalled();
			raf.mockRestore();
		});
	});
});

describe('ChatButtons', () => {
	const setup = () => {
		const host = new FakeChatWindow();
		const buttons = new ChatButtons(host.asChatWindow());
		buttons.init();
		const all = Array.from(host.inputWrapper.querySelectorAll('button')) as HTMLButtonElement[];
		const byLabel = (label: string) =>
			all.find(b => b.getAttribute('aria-label') === label) as HTMLButtonElement;
		return {
			host,
			buttons,
			all,
			save: byLabel('Save'),
			saveMenu: byLabel('More save options'),
			summarize: byLabel('Summarize'),
			send: byLabel('Send'),
		};
	};

	it('builds save, save-menu, summarize and send buttons', () => {
		const {all, save, saveMenu, summarize, send} = setup();

		expect(all).toHaveLength(4);
		for (const button of [save, saveMenu, summarize, send]) {
			expect(button).toBeDefined();
			// Obsidian's own class, so the buttons pick up theme styling.
			expect(button.classList.contains('clickable-icon')).toBe(true);
			// Obsidian draws its tooltip from aria-label; a title would add the browser's as well.
			expect(button.getAttribute('aria-label')).toBeTruthy();
			expect(button.hasAttribute('title')).toBe(false);
		}
	});

	it('splits the buttons into a left and a right area', () => {
		const {host, send} = setup();
		const right = host.inputWrapper.querySelector(`.${CSS_CLASS_PREFIX}button-area-right`);

		expect(send.parentElement).toBe(right);
	});

	// Summarize only applies once a context is loaded, so it starts hidden.
	it('starts with summarize hidden', () => {
		const {summarize} = setup();
		expect(summarize.classList.contains('hidden')).toBe(true);
	});

	it('shows and hides summarize', () => {
		const {buttons, summarize} = setup();

		buttons.showSummarizeButton();
		expect(summarize.classList.contains('hidden')).toBe(false);

		buttons.hideSummarizeButton();
		expect(summarize.classList.contains('hidden')).toBe(true);
	});

	describe('clicks', () => {
		it('saves in place from the save button', async () => {
			const {host, save} = setup();

			click(save);
			await flush();

			expect(host.saveChat).toHaveBeenCalledWith(host, false);
		});

		// A staged summary runs for minutes; the same button stops it.
		it('becomes a Stop button while a summary runs', async () => {
			const {host, buttons, summarize} = setup();
			const onStop = vi.fn();
			buttons.setSummarizeEnabled(false);

			buttons.setSummarizeStopping(onStop);
			click(summarize);
			await flush();

			expect(summarize.getAttribute('aria-label')).toBe('Stop');
			expect(summarize.hasAttribute('title')).toBe(false);
			expect(summarize.disabled).toBe(false);
			expect(onStop).toHaveBeenCalledTimes(1);
			expect(host.summarizeContext).not.toHaveBeenCalled();
		});

		it('turns back into Summarize', async () => {
			const {host, buttons, summarize} = setup();
			buttons.setSummarizeStopping(vi.fn());

			buttons.setSummarizeStopping(null);
			click(summarize);
			await flush();

			expect(summarize.getAttribute('aria-label')).toBe('Summarize');
			expect(host.summarizeContext).toHaveBeenCalledTimes(1);
		});

		it('summarizes from the summarize button', async () => {
			const {host, summarize} = setup();

			click(summarize);
			await flush();

			expect(host.summarizeContext).toHaveBeenCalledTimes(1);
		});

		it('sends from the send button', async () => {
			const {host, send} = setup();

			click(send);
			await flush();

			expect(host.sendInputAsChatMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe('save menu', () => {
		it('opens a menu anchored under the chevron', () => {
			const {saveMenu} = setup();

			click(saveMenu);

			expect(menus).toHaveLength(1);
			expect(menus[0].shownAt).not.toBeNull();
		});

		it('offers Save as… which saves under a new name', async () => {
			const {host, saveMenu} = setup();

			click(saveMenu);
			const item = menus[0].item('Save as…');
			expect(item?.icon).toBe('file-plus');

			await item?.click();

			expect(host.saveChat).toHaveBeenCalledWith(host, true);
		});

		// Without stopPropagation a parent handler could act on the same click.
		it('stops the click from propagating', () => {
			const {host, saveMenu} = setup();
			const onParent = vi.fn();
			host.inputWrapper.addEventListener('click', onParent);

			click(saveMenu);

			expect(onParent).not.toHaveBeenCalled();
		});
	});

	describe('enabled state', () => {
		it('disables and re-enables send', () => {
			const {buttons, send} = setup();

			buttons.setSendEnabled(false);
			expect(send.disabled).toBe(true);

			buttons.setSendEnabled(true);
			expect(send.disabled).toBe(false);
		});

		// Saving mid-stream would capture a half-written answer, so both save controls go together.
		it('disables both save controls together', () => {
			const {buttons, save, saveMenu} = setup();

			buttons.setSaveEnabled(false);

			expect(save.disabled).toBe(true);
			expect(saveMenu.disabled).toBe(true);
		});

		it('disables and re-enables summarize', () => {
			const {buttons, summarize} = setup();

			buttons.setSummarizeEnabled(false);
			expect(summarize.disabled).toBe(true);

			buttons.setSummarizeEnabled(true);
			expect(summarize.disabled).toBe(false);
		});
	});
});
