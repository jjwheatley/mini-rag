/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetMenus, __resetNotices, MarkdownRenderer, Notice, notices} from '../stubs/obsidian';
import {clipboard} from '../stubs/electron';
import {ChatWindow} from '../../src/classes/chat-window';
import {CSS_CLASS_PREFIX, RAG_CONTEXT_TEMPLATE} from '../../src/constants';
import {defaultSettings} from '../../src/defaults';
import {EmbeddingsUnsupportedError} from '../../src/providers/errors';
import {PluginSettings} from '../../src/types';
import MiniRagPlugin from '../../main';
import {click, flush} from '../helpers/ui';

interface SetupOptions {
	hasIndex?: boolean;
	hasContext?: boolean;
	relevantContext?: string;
	notes?: {name: string; text: string}[];
	/** What the provider reports as its context size; omitted means it cannot say. */
	contextLength?: number | null;
	settings?: Partial<PluginSettings>;
	unloaded?: boolean;
}

function setup(options: SetupOptions = {}) {
	const settings: PluginSettings = {...defaultSettings(), ...options.settings};
	settings.providers.ollama.chatModel = 'llama3';

	const tokens: string[] = [];
	/** The per-turn context each sendQuestion call carried, in order. */
	const contexts: (string | undefined)[] = [];
	const ai = {
		getEmbedding: vi.fn(async () => [1, 0]),
		getEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
		getModelList: vi.fn(async () => ['llama3']),
		clearContext: vi.fn(),
		abort: vi.fn(),
		waitForEmbeddingModelUnloaded: vi.fn(async () => options.unloaded ?? true),
		resolvedEmbeddingModel: 'nomic-embed-text',
		formatError: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
		// Shaped like Ollama's hint; each test that needs another shape overrides it once.
		embeddingInstallHint: vi.fn((model: string) => ({
			summary: `Mini-RAG expected to find "${model}" in Ollama.`,
			command: `ollama pull ${model}` as string | null,
			commandNote: undefined as string | undefined,
		})),
		...(options.contextLength === undefined ? {} : {contextLength: vi.fn(async () => options.contextLength)}),
		// The parts of a staged summary, and a summary that fits in one, go outside the conversation.
		complete: vi.fn(async (prompt: string, opts?: {
			onToken?: (t: string, f: string) => void;
			maxTokens?: number;
			onUsage?: (usage: {promptTokens: number}) => void;
		}) => {
			tokens.push(prompt);
			opts?.onToken?.('ans', 'answer');
			return 'answer';
		}),
		remember: vi.fn(),
		sendQuestion: vi.fn(async (
			prompt: string,
			opts?: {onToken?: (t: string, f: string) => void; context?: string},
		) => {
			tokens.push(prompt);
			contexts.push(opts?.context);
			opts?.onToken?.('ans', 'answer');
			return 'answer';
		}),
	};

	const context = {
		hasIndex: vi.fn(() => options.hasIndex ?? false),
		hasContext: vi.fn(() => options.hasContext ?? false),
		getRelevantContext: vi.fn(() => options.relevantContext ?? ''),
		getContextNotes: vi.fn(() => options.notes ?? []),
		buildIndex: vi.fn(async () => {}),
	};

	const plugin = {
		settings,
		ai,
		context,
		app: {},
		saveChat: vi.fn(async () => {}),
		saveSettings: vi.fn(async () => {}),
		getModelUserFriendlyName: () => 'Llama3',
		// As main.ts builds them.
		indexBuildErrorDeps: (chatWindow: ChatWindow) => ({
			dedicated: settings.providers.ollama.dedicatedEmbeddingEnabled,
			embeddingModel: ai.resolvedEmbeddingModel,
			showIndexError: (model: string) => chatWindow.showIndexError(model),
			notify: (message: string) => {
				new Notice(message);
			},
			formatError: ai.formatError,
		}),
	} as unknown as MiniRagPlugin;

	const view = new ChatWindow({} as never, plugin);
	// The stub ItemView supplies contentEl; ChatInput reads app.workspace through the view.
	(view as unknown as {app: unknown}).app = {workspace: {getActiveViewOfType: () => null}};

	return {view, plugin, ai, context, settings, prompts: tokens, contexts};
}

/** Three notes of about 1,000 characters: only the first fits a 1,024-token window. */
const BIG_NOTES = ['a', 'b', 'c'].map(letter => ({name: `${letter}.md`, text: letter.repeat(1000)}));

/** Three notes that a 1,024-token window summarises one part each. */
const STAGED_NOTES = ['a', 'b', 'c'].map(letter => ({name: `${letter}.md`, text: letter.repeat(1500)}));

/** The notes the transcript carries about what was left out of a request. */
const contextNotes = (view: ChatWindow) =>
	Array.from(view.chatContainer.querySelectorAll(`.${CSS_CLASS_PREFIX}context-note`), el => el.textContent);

async function open(options: SetupOptions = {}) {
	const harness = setup(options);
	await harness.view.onOpen();
	await flush();
	return harness;
}

beforeEach(() => {
	__resetMenus();
	__resetNotices();
	clipboard.writeText.mockClear();
	MarkdownRenderer.render.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('view identity', () => {
	it('reports its view type and display text', () => {
		const {view} = setup();

		expect(view.getViewType()).toBe('mini-rag-chat-window');
		expect(view.getDisplayText()).toBe('Mini-RAG');
	});

	it('sets the brain icon', () => {
		expect(setup().view.icon).toBe('brain');
	});
});

describe('onOpen', () => {
	it('builds the conversation area, loader and input', async () => {
		const {view} = await open();

		expect(view.chatContainer.classList.contains(`${CSS_CLASS_PREFIX}chat-container`)).toBe(true);
		expect(view.conversationWindow).toBeDefined();
		expect(view.loader).toBeDefined();
		expect(view.input.htmlElement.tagName).toBe('TEXTAREA');
	});

	it('starts a fresh message list and timestamp', async () => {
		const {view} = await open();

		expect(view.chatMessages.get()).toEqual([]);
		expect(view.chatStarted).toBeInstanceOf(Date);
	});

	it('starts ready to accept input', async () => {
		const {view} = await open();

		expect(view.input.canSend()).toBe(true);
		expect(view.loader.htmlElement.classList.contains('hidden')).toBe(true);
	});

	it('labels the input area', async () => {
		const {view} = await open();

		expect(view.inputWrapper.textContent).toContain('Ask a question');
	});
});

describe('onClose', () => {
	// Closing mid-stream must cancel the request rather than leave it running.
	it('aborts any in-flight request', async () => {
		const {view, ai} = await open();

		await view.onClose();

		expect(ai.abort).toHaveBeenCalledTimes(1);
	});
});

describe('sendTextAsChatMessage', () => {
	const transcript = (view: ChatWindow) => view.conversationWindow.htmlElement.textContent ?? '';

	it('shows the question, then the answer', async () => {
		const {view} = await open();

		await view.sendTextAsChatMessage('why?');

		expect(transcript(view)).toContain('why?');
		expect(view.chatMessages.get().map(m => m.content)).toEqual(['why?', 'answer']);
	});

	it('trims the question', async () => {
		const {view, prompts} = await open();

		await view.sendTextAsChatMessage('   why?   ');

		expect(prompts[0]).toBe('why?');
	});

	it('ignores blank input', async () => {
		const {view, ai} = await open();

		await view.sendTextAsChatMessage('   ');

		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});

	// Guards against a second send racing the first while a response streams.
	it('ignores a send while awaiting a response', async () => {
		const {view, ai} = await open();
		view.setAwaitingResponse(true);

		await view.sendTextAsChatMessage('why?');

		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});

	it('re-enables the controls afterwards', async () => {
		const {view} = await open();

		await view.sendTextAsChatMessage('why?');

		expect(view.input.canSend()).toBe(true);
	});

	describe('context selection', () => {
		it('sends the bare question with no context', async () => {
			const {view, prompts, contexts} = await open();

			await view.sendTextAsChatMessage('why?');

			expect(prompts[0]).toBe('why?');
			expect(contexts[0]).toBeUndefined();
		});

		// The excerpts travel as per-turn context, so the question the model -- and the history --
		// sees is exactly what the user typed.
		it('sends retrieved excerpts as context, alongside the bare question', async () => {
			const {view, prompts, contexts, context} = await open({
				hasIndex: true,
				relevantContext: `${RAG_CONTEXT_TEMPLATE}excerpt`,
			});

			await view.sendTextAsChatMessage('why?');

			expect(context.getRelevantContext).toHaveBeenCalled();
			expect(prompts[0]).toBe('why?');
			expect(contexts[0]).toBe(`${RAG_CONTEXT_TEMPLATE}excerpt`);
		});

		it('embeds the question to search with', async () => {
			const {view, ai} = await open({hasIndex: true, relevantContext: 'ctx'});

			await view.sendTextAsChatMessage('why?');

			expect(ai.getEmbedding).toHaveBeenCalledWith('why?');
		});

		it('passes the configured top-K through', async () => {
			const {view, context} = await open({
				hasIndex: true,
				relevantContext: 'ctx',
				settings: {ragTopK: 7},
			});

			await view.sendTextAsChatMessage('why?');

			expect(context.getRelevantContext).toHaveBeenCalledWith([1, 0], 7, expect.any(Number));
		});

		// The V1 fallback: no index because the model cannot embed, so inject everything.
		it('injects the whole raw context when there is context but no index', async () => {
			const {view, prompts, contexts, context} = await open({
				hasIndex: false,
				hasContext: true,
				notes: [{name: 'a.md', text: 'body'}],
			});

			await view.sendTextAsChatMessage('why?');

			expect(context.getContextNotes).toHaveBeenCalled();
			expect(prompts[0]).toBe('why?');
			expect(contexts[0]).toBe('[a.md]\nbody');
		});

		// 1,024 tokens leaves 512 for the prompt: 1,536 characters, less the question.
		it('fits the raw context to the model\'s window', async () => {
			const {view, contexts} = await open({
				hasContext: true,
				notes: BIG_NOTES,
				contextLength: 1024,
			});

			await view.sendTextAsChatMessage('why?');

			expect(contexts[0]).toContain('[a.md]');
			expect(contexts[0]).not.toContain('[b.md]');
			expect(contextNotes(view)).toEqual([
				'Only 1 of 3 notes fit in the model\'s 1,024-token context, so the rest were left out.',
			]);
		});

		// The same notes are left out every turn; saying so once is enough.
		it('says what was left out once, not on every question', async () => {
			const {view} = await open({hasContext: true, notes: BIG_NOTES, contextLength: 1024});

			await view.sendTextAsChatMessage('why?');
			await view.sendTextAsChatMessage('and?');

			expect(contextNotes(view)).toHaveLength(1);
		});

		// Ollama trims an over-long prompt silently; fitting an assumed window says what was cut.
		it('assumes a 4,096-token window when the provider cannot say', async () => {
			const notes = Array.from({length: 12}, (_, i) => ({name: `n${i}.md`, text: 'x'.repeat(1000)}));
			const {view, contexts} = await open({hasContext: true, notes});

			await view.sendTextAsChatMessage('why?');

			expect(contexts[0]).not.toContain('[n11.md]');
			expect(contextNotes(view)[0]).toMatch(/fit in an assumed 4,096-token context/);
		});

		it('assumes the same when the provider reports nothing', async () => {
			const notes = Array.from({length: 12}, (_, i) => ({name: `n${i}.md`, text: 'x'.repeat(1000)}));
			const {view} = await open({hasContext: true, notes, contextLength: null});

			await view.sendTextAsChatMessage('why?');

			expect(contextNotes(view)[0]).toMatch(/assumed 4,096-token/);
		});

		describe('asking the server for its window', () => {
			// One lookup per question would add a request to every turn.
			it('asks at most once a minute', async () => {
				const {view, ai} = await open({hasContext: true, notes: BIG_NOTES, contextLength: 8192});
				vi.useFakeTimers();

				await view.sendTextAsChatMessage('one');
				await view.sendTextAsChatMessage('two');
				expect(ai.contextLength).toHaveBeenCalledTimes(1);

				await vi.advanceTimersByTimeAsync(61_000);
				await view.sendTextAsChatMessage('three');
				expect(ai.contextLength).toHaveBeenCalledTimes(2);
			});

			// A server may be able to say later, so keep asking.
			it('asks again while the server reports nothing', async () => {
				const {view, ai} = await open({hasContext: true, notes: BIG_NOTES, contextLength: null});

				await view.sendTextAsChatMessage('one');
				await view.sendTextAsChatMessage('two');

				expect(ai.contextLength).toHaveBeenCalledTimes(2);
			});

			// A provider switch replaces plugin.ai; the old provider's window says nothing of the new.
			it('asks a new provider afresh', async () => {
				const {view, plugin, ai} = await open({hasContext: true, notes: BIG_NOTES, contextLength: 8192});
				await view.sendTextAsChatMessage('one');
				const replacement = {...ai, contextLength: vi.fn(async () => 4096)};
				(plugin as unknown as {ai: unknown}).ai = replacement;

				await view.sendTextAsChatMessage('two');

				expect(replacement.contextLength).toHaveBeenCalledTimes(1);
			});
		});

		it('says nothing when everything fits', async () => {
			const {view} = await open({hasContext: true, notes: [{name: 'a.md', text: 'body'}], contextLength: 8192});

			await view.sendTextAsChatMessage('why?');

			expect(contextNotes(view)).toEqual([]);
		});

		it('sends the bare question, with no context, when retrieval finds nothing', async () => {
			const {view, prompts, contexts} = await open({hasIndex: true, relevantContext: ''});

			await view.sendTextAsChatMessage('why?');

			expect(prompts[0]).toBe('why?');
			expect(contexts[0]).toBeUndefined();
		});

		it('does not embed when there is no index', async () => {
			const {view, ai} = await open({hasContext: true, notes: [{name: 'a.md', text: 'ctx'}]});

			await view.sendTextAsChatMessage('why?');

			expect(ai.getEmbedding).not.toHaveBeenCalled();
		});
	});

	describe('embedding model unload', () => {
		it('waits for the unload when a dedicated embedding model is configured', async () => {
			const harness = setup({hasIndex: true, relevantContext: 'ctx'});
			harness.settings.providers.ollama.dedicatedEmbeddingEnabled = true;
			await harness.view.onOpen();

			await harness.view.sendTextAsChatMessage('why?');

			expect(harness.ai.waitForEmbeddingModelUnloaded).toHaveBeenCalled();
		});

		it('does not wait when the chat model doubles as the embedding model', async () => {
			const {view, ai} = await open({hasIndex: true, relevantContext: 'ctx'});

			await view.sendTextAsChatMessage('why?');

			expect(ai.waitForEmbeddingModelUnloaded).not.toHaveBeenCalled();
		});

		// Pinned VRAM makes the chat model's CUDA init fail, so the user gets a heads-up.
		it('warns when the unload times out, but still answers', async () => {
			const harness = setup({hasIndex: true, relevantContext: 'ctx', unloaded: false});
			harness.settings.providers.ollama.dedicatedEmbeddingEnabled = true;
			await harness.view.onOpen();

			await harness.view.sendTextAsChatMessage('why?');

			expect(notices.some(n => n.includes('did not unload in time'))).toBe(true);
			expect(harness.ai.sendQuestion).toHaveBeenCalled();
		});
	});

	describe('streaming', () => {
		it('renders tokens as they arrive and keeps the message in sync', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockImplementationOnce(async (_p, opts) => {
				opts?.onToken?.('He', 'He');
				opts?.onToken?.('llo', 'Hello');
				return 'Hello';
			});

			await view.sendTextAsChatMessage('hi');

			expect(view.chatMessages.get()[1].content).toBe('Hello');
		});
	});

	describe('failures', () => {
		it('shows the formatted error as an assistant message and a notice', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockRejectedValueOnce(new Error('model exploded'));

			await view.sendTextAsChatMessage('why?');

			// The error bubble is rendered as markdown, so the renderer is what receives the text.
			expect(MarkdownRenderer.render).toHaveBeenCalledWith(
				expect.anything(), 'model exploded', expect.anything(), '', expect.anything(),
			);
			expect(notices).toContain('model exploded');
			expect(ai.formatError).toHaveBeenCalled();
		});

		// Multi-line guidance (the GPU advice) would overflow a toast, so only the headline goes
		// to the notice while the full text lands in the transcript.
		it('shows only the first line of a multi-line error as the notice', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockRejectedValueOnce(new Error('headline\ndetail line'));

			await view.sendTextAsChatMessage('why?');

			expect(notices).toContain('headline');
			expect(MarkdownRenderer.render).toHaveBeenCalledWith(
				expect.anything(), 'headline\ndetail line', expect.anything(), '', expect.anything(),
			);
		});

		it('drops the placeholder message on failure', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockRejectedValueOnce(new Error('boom'));

			await view.sendTextAsChatMessage('why?');

			expect(view.chatMessages.get().map(m => m.content)).toEqual(['why?']);
		});

		// Closing the panel mid-stream is not a failure the user needs told about.
		it('stays silent on an abort', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));

			await view.sendTextAsChatMessage('why?');

			expect(notices).toEqual([]);
			expect(MarkdownRenderer.render).not.toHaveBeenCalled();
		});

		it('re-enables the controls after a failure', async () => {
			const {view, ai} = await open();
			ai.sendQuestion.mockRejectedValueOnce(new Error('boom'));

			await view.sendTextAsChatMessage('why?');

			expect(view.input.canSend()).toBe(true);
		});
	});
});

// What fits is the window's to decide: the question, then excerpts, then as much conversation as
// is left. 1,024 tokens leave 512 for the prompt, at three characters each: 1,536.
describe('fitting a question to the window', () => {
	const budgetOf = (ai: {sendQuestion: {mock: {calls: unknown[][]}}}) =>
		(ai.sendQuestion.mock.calls[0][1] as {budgetChars?: number}).budgetChars;

	it('gives excerpts at most 60% of what the question leaves', async () => {
		const {view, context} = await open({hasIndex: true, relevantContext: 'ctx', contextLength: 1024});

		await view.sendTextAsChatMessage('why?');

		expect(context.getRelevantContext).toHaveBeenCalledWith([1, 0], expect.any(Number), Math.floor(0.6 * (1536 - 4)));
	});

	it('gives the request the window\'s budget, for the conversation to fit', async () => {
		const {view, ai} = await open({hasIndex: true, relevantContext: 'ctx', contextLength: 1024});

		await view.sendTextAsChatMessage('why?');

		expect(budgetOf(ai)).toBe(1536);
	});

	it('does the same when the whole context is sent', async () => {
		const {view, ai} = await open({hasContext: true, notes: [{name: 'a.md', text: 'body'}], contextLength: 1024});

		await view.sendTextAsChatMessage('why?');

		expect(budgetOf(ai)).toBe(1536);
	});

	// No context still has a conversation to fit; Ollama's window is assumed.
	it('does the same in a context-free chat, on an assumed window', async () => {
		const {view, ai} = await open();

		await view.sendTextAsChatMessage('why?');

		expect(budgetOf(ai)).toBe((4096 - 1024) * 3);
	});
});

describe('sendInputAsChatMessage', () => {
	it('sends and clears the textarea', async () => {
		const {view, prompts} = await open();
		view.input.setValue('typed question');

		await view.sendInputAsChatMessage();

		expect(prompts[0]).toBe('typed question');
		expect(view.input.getValue()).toBe('');
	});

	it('does nothing for an empty box', async () => {
		const {view, ai} = await open();

		await view.sendInputAsChatMessage();

		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});

	it('does nothing for whitespace only', async () => {
		const {view, ai} = await open();
		view.input.setValue('   ');

		await view.sendInputAsChatMessage();

		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});

	it('does nothing while sending is disabled', async () => {
		const {view, ai} = await open();
		view.input.setValue('question');
		view.input.setSendEnabled(false);

		await view.sendInputAsChatMessage();

		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});
});

describe('summarizeContext', () => {
	// Whole notes rather than index chunks: the same text, but each note labelled once, which
	// is also the unit that is left out when they do not all fit.
	it('summarizes the context notes', async () => {
		const {view, prompts} = await open({notes: [{name: 'a.md', text: 'A'}, {name: 'b.md', text: 'B'}]});

		await view.summarizeContext();

		expect(prompts[0]).toBe('Please summarize the following content:\n\n[a.md]\nA\n\n---\n\n[b.md]\nB');
	});

	// The chat remembers that a summary was asked for and what it said — not the folder's text.
	it('remembers the request and the summary', async () => {
		const {view, ai} = await open({notes: [{name: 'a.md', text: 'A'}]});

		await view.summarizeContext();

		expect(ai.remember).toHaveBeenCalledWith('Summarize', 'answer');
		expect(ai.sendQuestion).not.toHaveBeenCalled();
	});

	it('shows no progress when one request will do', async () => {
		const {view} = await open({notes: [{name: 'a.md', text: 'A'}], contextLength: 8192});

		await view.summarizeContext();

		expect(contextNotes(view)).toEqual([]);
	});

	describe('a folder too large for one request', () => {
		const summarizeButton = (view: ChatWindow) =>
			view.inputWrapper.querySelector('[aria-label="Summarize"], [aria-label="Stop"]') as HTMLButtonElement;

		// 1,024 tokens leaves room for one of the three notes per request.
		it('summarizes it in parts, then combines them', async () => {
			const {view, prompts} = await open({notes: STAGED_NOTES, contextLength: 1024});

			await view.summarizeContext();

			expect(prompts.map(prompt => prompt.split(' of a set')[0].split(' parts')[0])).toEqual([
				'This is part 1 of 3',
				'This is part 2 of 3',
				'This is part 3 of 3',
				'These are summaries of 3',
			]);
			expect(view.chatMessages.get().at(-1)?.content).toBe('answer');
		});

		// The provider tells the summariser what each part cost, so the next can be sized to fit.
		it('caps each part, and passes the server\'s token count on', async () => {
			const notes = Array.from({length: 30}, (_, i) => ({name: `n${i}.md`, text: 'word '.repeat(100)}));
			const {view, ai, prompts} = await open({notes, contextLength: 1024});
			ai.complete.mockImplementation(async (prompt: string, opts?: {onUsage?: (u: {promptTokens: number}) => void}) => {
				prompts.push(prompt);
				opts?.onUsage?.({promptTokens: Math.ceil(prompt.length / 4.65)});
				return 'answer';
			});

			await view.summarizeContext();

			expect(ai.complete.mock.calls[0][1]).toMatchObject({maxTokens: 300});
			expect(prompts[1].length).toBeGreaterThan(prompts[0].length * 1.25);
		});

		it('counts the parts in one line, then says what it covered', async () => {
			const {view, ai} = await open({notes: STAGED_NOTES, contextLength: 1024});
			const seen: (string | null)[] = [];
			ai.complete.mockImplementation(async (_prompt: string, opts?: {onToken?: (t: string, f: string) => void}) => {
				seen.push(contextNotes(view).join(' | '));
				opts?.onToken?.('ans', 'answer');
				return 'answer';
			});

			await view.summarizeContext();

			expect(seen).toEqual([
				'Summarizing part 1 of 3…',
				'Summarizing part 2 of 3…',
				'Summarizing part 3 of 3…',
				'Combining the summaries of 3 parts…',
			]);
			expect(contextNotes(view)).toEqual(['Summarized 3 notes in 3 parts.']);
		});

		// One note too large for a request on its own is summarized in pieces.
		it('counts a single note as one', async () => {
			const {view} = await open({notes: [{name: 'big.md', text: 'word '.repeat(600)}], contextLength: 1024});

			await view.summarizeContext();

			expect(contextNotes(view)[0]).toMatch(/^Summarized 1 note in \d+ parts\.$/);
		});

		it('says when the window was assumed', async () => {
			const notes = Array.from({length: 12}, (_, i) => ({name: `n${i}.md`, text: 'x'.repeat(1000)}));
			const {view} = await open({notes});

			await view.summarizeContext();

			expect(contextNotes(view)[0]).toMatch(/^Summarized 12 notes in \d+ parts \(assumed 4,096-token context\)\.$/);
		});

		it('offers Stop while it runs, and Summarize again after', async () => {
			const {view, ai} = await open({notes: STAGED_NOTES, contextLength: 1024});
			const labels: (string | null)[] = [];
			ai.complete.mockImplementation(async () => {
				labels.push(summarizeButton(view).getAttribute('aria-label'));
				return 'answer';
			});

			await view.summarizeContext();

			expect(labels.every(label => label === 'Stop')).toBe(true);
			expect(summarizeButton(view).getAttribute('aria-label')).toBe('Summarize');
		});

		it('stops at Stop, quietly, saying where', async () => {
			const {view, ai} = await open({notes: STAGED_NOTES, contextLength: 1024});
			ai.complete.mockImplementationOnce(async () => 'answer');
			ai.complete.mockImplementationOnce(async () => {
				click(summarizeButton(view));
				throw new DOMException('Stopped', 'AbortError');
			});

			await view.summarizeContext();

			expect(ai.abort).toHaveBeenCalled();
			expect(notices).toEqual([]);
			expect(contextNotes(view)).toEqual(['Stopped at part 2 of 3.']);
			expect(ai.remember).not.toHaveBeenCalled();
			expect(view.input.canSend()).toBe(true);
		});

		it('says where it stopped when a part fails', async () => {
			const {view, ai} = await open({notes: STAGED_NOTES, contextLength: 1024});
			ai.complete.mockImplementationOnce(async () => 'answer');
			ai.complete.mockImplementationOnce(async () => {
				throw new Error('boom');
			});

			await view.summarizeContext();

			expect(notices).toContain('boom');
			expect(contextNotes(view)).toEqual(['Stopped at part 2 of 3.']);
			expect(summarizeButton(view).getAttribute('aria-label')).toBe('Summarize');
		});

		it('says so when stopped while combining', async () => {
			const {view, ai} = await open({notes: STAGED_NOTES, contextLength: 1024});
			ai.complete.mockImplementation(async (prompt: string) => {
				if (prompt.startsWith('These are summaries')) throw new DOMException('Stopped', 'AbortError');
				return 'answer';
			});

			await view.summarizeContext();

			expect(contextNotes(view)).toEqual(['Stopped while combining the summaries.']);
		});
	});

	it('asks for a bare summary with no context at all', async () => {
		const {view, prompts} = await open();

		await view.summarizeContext();

		expect(prompts[0]).toBe('Please summarize.');
	});

	it('records the request as a user message', async () => {
		const {view} = await open({notes: [{name: 'a.md', text: 'ctx'}]});

		await view.summarizeContext();

		expect(view.chatMessages.get()[0].content).toBe('Summarize');
	});

	it('ignores a request while awaiting a response', async () => {
		const {view, ai} = await open({notes: [{name: 'a.md', text: 'ctx'}]});
		view.setAwaitingResponse(true);

		await view.summarizeContext();

		expect(ai.complete).not.toHaveBeenCalled();
	});

	it('reports a failure', async () => {
		const {view, ai} = await open({notes: [{name: 'a.md', text: 'ctx'}]});
		ai.complete.mockRejectedValueOnce(new Error('summarize failed'));

		await view.summarizeContext();

		expect(notices).toContain('summarize failed');
	});

	it('stays silent on an abort', async () => {
		const {view, ai} = await open({notes: [{name: 'a.md', text: 'ctx'}]});
		ai.complete.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));

		await view.summarizeContext();

		expect(notices).toEqual([]);
	});
});

describe('setAwaitingResponse', () => {
	it('disables every control while awaiting', async () => {
		const {view} = await open();

		view.setAwaitingResponse(true);

		expect(view.input.canSend()).toBe(false);
	});

	it('shows the loader by default', async () => {
		const {view} = await open();

		view.setAwaitingResponse(true);

		expect(view.loader.htmlElement.classList.contains('hidden')).toBe(false);
	});

	// Streaming shows tokens immediately, so a spinner would just be noise.
	it('suppresses the loader when told to', async () => {
		const {view} = await open();

		view.setAwaitingResponse(true, {showLoader: false});

		expect(view.loader.htmlElement.classList.contains('hidden')).toBe(true);
	});

	it('hides the loader when done', async () => {
		const {view} = await open();
		view.setAwaitingResponse(true);

		view.setAwaitingResponse(false);

		expect(view.loader.htmlElement.classList.contains('hidden')).toBe(true);
	});
});

describe('resetChat', () => {
	it('clears the transcript and messages', async () => {
		const {view} = await open();
		await view.sendTextAsChatMessage('why?');

		view.resetChat();

		expect(view.chatMessages.get()).toEqual([]);
		expect(view.conversationWindow.htmlElement.children).toHaveLength(0);
	});

	it('forgets the saved path, so the next save writes a new file', async () => {
		const {view} = await open();
		view.savedChatPath = 'Chats/old.md';

		view.resetChat();

		expect(view.savedChatPath).toBeNull();
	});

	it('records the context subject and offers summarize', async () => {
		const {view} = await open();

		view.resetChat('Projects');

		expect(view.chatSubject).toBe('Projects');
		const summarize = view.inputWrapper.querySelector('[aria-label="Summarize"]');
		expect(summarize?.classList.contains('hidden')).toBe(false);
	});

	// Summarize is meaningless without a context.
	it('hides summarize for a context-free chat', async () => {
		const {view} = await open();
		view.resetChat('Projects');

		view.resetChat();

		const summarize = view.inputWrapper.querySelector('[aria-label="Summarize"]');
		expect(summarize?.classList.contains('hidden')).toBe(true);
	});

	it('restarts the chat clock', async () => {
		const {view} = await open();
		const before = view.chatStarted;
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2030, 0, 1));

		view.resetChat();

		expect(view.chatStarted.getTime()).not.toBe(before.getTime());
	});
});

describe('showIndexError', () => {
	const panel = (view: ChatWindow) =>
		view.chatContainer.querySelector(`.${CSS_CLASS_PREFIX}index-error`) as HTMLElement;

	// The words come from the active provider, so llama.cpp users are not told to run
	// `ollama pull`.
	it('says what was expected, then what to do, in two steps', async () => {
		const {view, ai} = await open();

		view.showIndexError('nomic-embed-text');

		expect(ai.embeddingInstallHint).toHaveBeenCalledWith('nomic-embed-text');
		expect(panel(view).querySelector('p')?.textContent).toBe('Mini-RAG expected to find "nomic-embed-text" in Ollama. Please:');
		const steps = Array.from(panel(view).querySelectorAll('ol > li'));
		expect(steps).toHaveLength(2);
		expect(steps[0].firstChild?.textContent).toBe('Run this command:');
		expect(steps[0].querySelector('code')?.textContent).toBe('ollama pull nomic-embed-text');
		expect(steps[1].textContent).toBe('Click "Refresh" below.');
	});

	// llama-server keeps running, so it needs a terminal of its own.
	it('says how to run the command when the provider does', async () => {
		const {view, ai} = await open();
		ai.embeddingInstallHint.mockReturnValueOnce({
			summary: 'Mini-RAG expected to find "nomic-embed-text" running on port 8081.',
			command: 'llama-server -hf x --embeddings --port 8081',
			commandNote: 'in a separate terminal to any others',
		});

		view.showIndexError('m');

		expect(panel(view).querySelector('ol > li')?.firstChild?.textContent)
			.toBe('Run this command (in a separate terminal to any others):');
	});

	it('goes straight to Refresh when there is nothing to run', async () => {
		const {view, ai} = await open();
		ai.embeddingInstallHint.mockReturnValueOnce({summary: 'Start a second server.', command: null, commandNote: undefined});

		view.showIndexError('m');

		expect(Array.from(panel(view).querySelectorAll('ol > li'), li => li.textContent)).toEqual(['Click "Refresh" below.']);
		expect(panel(view).querySelector('code')).toBeNull();
		expect(panel(view).querySelector('[aria-label="Copy"]')).toBeNull();
	});

	it('points to the settings and to support if that does not work', async () => {
		const {view} = await open();

		view.showIndexError('m');

		const footer = panel(view).querySelector(`.${CSS_CLASS_PREFIX}index-error-support`);
		expect(footer?.textContent).toBe('If problems persist, check the settings for Mini-RAG or contact support.');
		expect(footer?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/jjwheatley/mini-rag/issues');
		expect(footer?.querySelector('a')?.textContent).toBe('contact support');
	});

	it('hides the chat UI behind the panel', async () => {
		const {view} = await open();

		view.showIndexError('m');

		expect(view.conversationWindow.headerEl.classList.contains('hidden')).toBe(true);
		expect(view.conversationWindow.htmlElement.classList.contains('hidden')).toBe(true);
		expect(view.inputWrapper.classList.contains('hidden')).toBe(true);
	});

	// Repeated build failures must not stack panels on top of each other.
	it('replaces an existing panel rather than adding a second', async () => {
		const {view} = await open();

		view.showIndexError('m');
		view.showIndexError('m');

		expect(view.chatContainer.querySelectorAll(`.${CSS_CLASS_PREFIX}index-error`)).toHaveLength(1);
	});

	describe('copy button', () => {
		const copy = (view: ChatWindow) => panel(view).querySelector('[aria-label="Copy"]') as Element;

		// Obsidian draws its tooltip from aria-label; a title would add the browser's as well.
		it('has one tooltip', async () => {
			const {view} = await open();
			view.showIndexError('nomic-embed-text');

			expect(copy(view).hasAttribute('title')).toBe(false);
		});

		it('copies the command', async () => {
			const {view} = await open();
			view.showIndexError('nomic-embed-text');

			click(copy(view));

			expect(clipboard.writeText).toHaveBeenCalledWith('ollama pull nomic-embed-text');
		});

		it('confirms the copy, then reverts the label', async () => {
			const {view} = await open();
			// Fake timers go in after open(), whose async setup needs a real setTimeout.
			vi.useFakeTimers();
			view.showIndexError('m');
			const button = copy(view);

			click(button);
			expect(button.getAttribute('aria-label')).toBe('Copied!');

			vi.advanceTimersByTime(2000);
			expect(button.getAttribute('aria-label')).toBe('Copy');
		});

		it('reports a clipboard failure', async () => {
			const {view} = await open();
			view.showIndexError('m');
			clipboard.writeText.mockImplementationOnce(() => {
				throw new Error('no clipboard');
			});

			click(copy(view));

			expect(notices).toContain('Could not copy to clipboard.');
		});
	});

	describe('refresh', () => {
		const refresh = (view: ChatWindow) => panel(view).querySelector('[aria-label="Refresh"]') as Element;

		it('rebuilds the index and restores the chat UI on success', async () => {
			const {view, context} = await open();
			view.showIndexError('m');

			click(refresh(view));
			await flush();

			expect(context.buildIndex).toHaveBeenCalled();
			expect(view.inputWrapper.classList.contains('hidden')).toBe(false);
			expect(view.chatContainer.querySelector(`.${CSS_CLASS_PREFIX}index-error`)).toBeNull();
		});

		it('shows the panel again when the rebuild fails', async () => {
			const {view, context, settings} = await open();
			settings.providers.ollama.dedicatedEmbeddingEnabled = true;
			view.showIndexError('m');
			context.buildIndex.mockRejectedValueOnce(new EmbeddingsUnsupportedError('m', 'ollama'));

			click(refresh(view));
			await flush();

			expect(panel(view)).not.toBeNull();
			// Re-read from the provider, so a settings change since the failure is picked up.
			expect(panel(view).textContent).toContain('nomic-embed-text');
		});

		// A retry means the same as any other build failure: a chat model that cannot embed falls
		// back to sending the notes whole, rather than asking the user to install something.
		it('falls back, as any build does, when the chat model cannot embed', async () => {
			const {view, context} = await open();
			view.showIndexError('m');
			context.buildIndex.mockRejectedValueOnce(new EmbeddingsUnsupportedError('m', 'ollama'));

			click(refresh(view));
			await flush();

			expect(panel(view)).toBeNull();
			expect(view.inputWrapper.classList.contains('hidden')).toBe(false);
		});
	});

	// Nothing to install: the fix is choosing a model, and the help must not name an empty one.
	describe('with no model chosen', () => {
		it('asks for a chat model to be chosen', async () => {
			const {view, ai} = await open();

			view.showIndexError('');

			expect(ai.embeddingInstallHint).not.toHaveBeenCalled();
			expect(panel(view).querySelector('p')?.textContent).toBe('Mini-RAG has no model chosen to read your notes with. Please:');
			expect(Array.from(panel(view).querySelectorAll('ol > li'), li => li.textContent)).toEqual([
				'Choose a Chat Model in Mini-RAG\'s settings.',
				'Click "Refresh" below.',
			]);
			expect(panel(view).querySelector('code')).toBeNull();
			expect(panel(view).textContent).not.toContain('""');
		});

		it('asks for an embedding model when a dedicated one is in use', async () => {
			const {view, settings} = await open();
			settings.providers.ollama.dedicatedEmbeddingEnabled = true;

			view.showIndexError('');

			expect(panel(view).querySelector('ol > li')?.textContent).toBe('Choose an Embedding Model in Mini-RAG\'s settings.');
		});
	});

	it('is cleared by resetChat', async () => {
		const {view} = await open();
		view.showIndexError('m');

		view.resetChat();

		expect(view.chatContainer.querySelector(`.${CSS_CLASS_PREFIX}index-error`)).toBeNull();
		expect(view.inputWrapper.classList.contains('hidden')).toBe(false);
	});
});

describe('modelChanged', () => {
	it('has the conversation pane show the new model', async () => {
		const {view} = await open();
		const modelChanged = vi.spyOn(view.conversationWindow, 'modelChanged').mockImplementation(() => {});

		view.modelChanged();

		expect(modelChanged).toHaveBeenCalledTimes(1);
	});
});
