/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetNotices, __resetSettings, __setting, ButtonComponent, notices, settingRows} from '../stubs/obsidian';
import {SaveChatAsModal} from '../../src/classes/ui/save-chat-as-modal';
import {ChatWindow} from '../../src/classes/chat-window';
import {CSS_CLASS_PREFIX} from '../../src/constants';
import MiniRagPlugin from '../../main';
import {keydown} from '../helpers/ui';

interface SetupOptions {
	existing?: string[];
	savedChatPath?: string | null;
	writeFails?: boolean;
}

function setup(options: SetupOptions = {}) {
	const existing = new Set(options.existing ?? []);
	const plugin = {
		getModelUserFriendlyName: () => 'Llama3',
		fileManager: {fileExists: vi.fn((path: string) => existing.has(path))},
		writeChatToFile: vi.fn(async () => {
			if (options.writeFails) throw new Error('disk full');
		}),
	} as unknown as MiniRagPlugin;

	const chatWindow = {
		chatStarted: new Date(2026, 8, 10, 14, 30, 45, 7),
		savedChatPath: options.savedChatPath ?? null,
	} as unknown as ChatWindow;

	const modal = new SaveChatAsModal({} as never, plugin, chatWindow);
	modal.open();
	const input = modal.contentEl.querySelector('input') as HTMLInputElement;
	return {modal, plugin, chatWindow, input};
}

const button = (label: string) =>
	settingRows
		.flatMap(row => row.components)
		.find((c): c is ButtonComponent => c instanceof ButtonComponent && c.text === label) as ButtonComponent;

/** The stub Modal tracks open state; the real typings do not expose it. */
const isOpen = (modal: SaveChatAsModal) => (modal as unknown as {isOpen: boolean}).isOpen;

/** Lets the fire-and-forget submit() settle. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
	__resetNotices();
	__resetSettings();
});

describe('onOpen', () => {
	it('titles the dialog and styles its content', () => {
		const {modal} = setup();

		expect(modal.titleEl.textContent).toBe('Save chat as');
		expect(modal.contentEl.classList.contains(`${CSS_CLASS_PREFIX}save-as-modal`)).toBe(true);
	});

	// Milliseconds are included so two saves in the same second cannot collide.
	it('suggests a timestamped name without the extension', () => {
		const {input} = setup();

		expect(input.value).toBe('2026-09-10 14-30-45-007 - Chat with Llama3');
	});

	it('shows the target folder', () => {
		setup();

		expect(__setting('File name')?.desc).toBe('Saved in Mini-RAG Chats/');
	});

	it('offers Save and Cancel', () => {
		setup();

		expect(button('Save')).toBeDefined();
		expect(button('Cancel')).toBeDefined();
	});

	it('empties the content first, so reopening does not duplicate the form', () => {
		const {modal} = setup();

		modal.onOpen();

		expect(modal.contentEl.querySelectorAll('input')).toHaveLength(1);
	});
});

describe('saving', () => {
	it('writes the chat under the chats folder and closes', async () => {
		const {modal, plugin, chatWindow, input} = setup();
		input.value = 'My chat';

		await button('Save').click();
		await settle();

		expect(plugin.writeChatToFile).toHaveBeenCalledWith(chatWindow, 'Mini-RAG Chats/My chat.md');
		expect(notices).toContain('Chat saved as: Mini-RAG Chats/My chat.md');
		expect(isOpen(modal)).toBe(false);
	});

	it('saves on Enter', async () => {
		const {plugin, input} = setup();
		input.value = 'My chat';

		const event = keydown(input, 'Enter');
		await settle();

		expect(event.defaultPrevented).toBe(true);
		expect(plugin.writeChatToFile).toHaveBeenCalled();
	});

	it('ignores other keys', async () => {
		const {plugin, input} = setup();

		keydown(input, 'a');
		await settle();

		expect(plugin.writeChatToFile).not.toHaveBeenCalled();
	});

	it('sanitizes the typed name', async () => {
		const {plugin, chatWindow, input} = setup();
		input.value = 'a/b:c';

		await button('Save').click();
		await settle();

		expect(plugin.writeChatToFile).toHaveBeenCalledWith(chatWindow, 'Mini-RAG Chats/a-b-c.md');
	});

	it('refuses an empty name and stays open', async () => {
		const {modal, plugin, input} = setup();
		input.value = '   ';

		await button('Save').click();
		await settle();

		expect(notices).toContain('Enter a file name.');
		expect(plugin.writeChatToFile).not.toHaveBeenCalled();
		expect(isOpen(modal)).toBe(true);
	});

	// Save-as must never clobber a different chat.
	it('refuses a name that belongs to another file', async () => {
		const {modal, plugin, input} = setup({existing: ['Mini-RAG Chats/Taken.md']});
		input.value = 'Taken';

		await button('Save').click();
		await settle();

		expect(notices.some(n => n.includes('already exists'))).toBe(true);
		expect(plugin.writeChatToFile).not.toHaveBeenCalled();
		expect(isOpen(modal)).toBe(true);
	});

	it('allows overwriting the chat it was already saved as', async () => {
		const {plugin, input} = setup({
			existing: ['Mini-RAG Chats/Mine.md'],
			savedChatPath: 'Mini-RAG Chats/Mine.md',
		});
		input.value = 'Mine';

		await button('Save').click();
		await settle();

		expect(plugin.writeChatToFile).toHaveBeenCalled();
	});

	// A double-click or Enter-then-click must not write twice.
	it('ignores a second submit while the first is in flight', async () => {
		const {plugin, input} = setup();
		input.value = 'My chat';
		let release: () => void = () => {};
		(plugin.writeChatToFile as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() => new Promise<void>(resolve => {
				release = resolve;
			}),
		);

		void button('Save').click();
		void button('Save').click();
		release();
		await settle();

		expect(plugin.writeChatToFile).toHaveBeenCalledTimes(1);
	});

	// Regression: submit() runs fire-and-forget, so a failed write used to escape as an unhandled
	// rejection with no feedback at all. It now reports like the in-place save path does.
	it('reports a failed write and stays open', async () => {
		const {modal, input} = setup({writeFails: true});
		input.value = 'My chat';

		await button('Save').click();
		await settle();

		expect(notices).toContain('Mini-RAG: failed to save chat. disk full');
		expect(isOpen(modal)).toBe(true);
	});

	it('allows another attempt after a failed write', async () => {
		const {plugin, input} = setup({writeFails: true});
		input.value = 'My chat';

		keydown(input, 'Enter');
		await settle();
		keydown(input, 'Enter');
		await settle();

		expect(plugin.writeChatToFile).toHaveBeenCalledTimes(2);
	});
});

describe('cancel', () => {
	it('closes without saving', async () => {
		const {modal, plugin} = setup();

		await button('Cancel').click();

		expect(isOpen(modal)).toBe(false);
		expect(plugin.writeChatToFile).not.toHaveBeenCalled();
	});
});
