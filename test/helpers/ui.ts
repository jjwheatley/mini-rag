/**
 * Fakes for driving the DOM-bound UI classes under jsdom.
 *
 * Each UI class takes the whole ChatWindow, but touches only a handful of its members, so the
 * fake exposes exactly those and records what was called. Anything a class reaches for that is
 * not here will fail loudly rather than silently no-op.
 */
import {vi} from 'vitest';
import {Component} from '../stubs/obsidian';
import {ChatWindow} from '../../src/classes/chat-window';
import MiniRagPlugin from '../../main';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings} from '../../src/types';

/** A container attached to the document, so layout-ish reads behave. */
export function makeContainer(): HTMLElement {
	document.body.innerHTML = '';
	const el = document.createElement('div');
	document.body.appendChild(el);
	return el;
}

export interface FakeChatWindowOptions {
	settings?: Partial<PluginSettings>;
	activeView?: unknown;
}

/**
 * A stand-in for ChatWindow that really registers DOM listeners (via Component) so click and
 * keydown behaviour is exercised rather than assumed.
 */
export class FakeChatWindow extends Component {
	inputWrapper: HTMLElement;
	chatContainer: HTMLElement;
	plugin: MiniRagPlugin;
	app: {workspace: {getActiveViewOfType: (type: unknown) => unknown}};

	sendInputAsChatMessage = vi.fn(async () => {});
	summarizeContext = vi.fn(async () => {});
	saveChat = vi.fn(async () => {});
	settings: PluginSettings;

	constructor(options: FakeChatWindowOptions = {}) {
		super();
		this.chatContainer = makeContainer();
		this.inputWrapper = this.chatContainer.createEl('div');
		this.settings = {...defaultSettings(), ...options.settings};
		this.plugin = {
			settings: this.settings,
			saveChat: this.saveChat,
			ai: {
				getModelList: vi.fn(async () => []),
				clearContext: vi.fn(),
				displayModelName: (id: string) => id,
				formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
				capabilities: {displayName: 'Ollama'},
			},
			saveSettings: vi.fn(async () => {}),
			getModelUserFriendlyName: () => 'Test Model',
		} as unknown as MiniRagPlugin;
		this.app = {
			workspace: {
				getActiveViewOfType: () => options.activeView ?? null,
			},
		};
	}

	/** Casts to ChatWindow for the classes that demand the real type. */
	asChatWindow(): ChatWindow {
		return this as unknown as ChatWindow;
	}
}

/** Dispatches a real click, so the registered listener runs. */
export function click(el: Element): void {
	el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
}

/** Dispatches a keydown, returning the event so preventDefault can be asserted. */
export function keydown(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init});
	el.dispatchEvent(event);
	return event;
}

/** Lets queued promise callbacks run, for the async handlers the UI registers. */
export function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}
