import {afterEach, describe, expect, it, vi} from 'vitest';
import {BaseHttpProvider} from '../../src/providers/base-http-provider';
import {EmbeddingsUnsupportedError, ProviderError} from '../../src/providers/errors';
import {
	AiProvider,
	ChatMessage,
	ChatRequestOptions,
	ModelInstallHint,
	ProviderCapabilities,
	ProviderId,
} from '../../src/providers/types';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings, ProviderConfig} from '../../src/types';

/**
 * A minimal concrete provider, exercising the base class's own defaults rather than Ollama's
 * overrides. These defaults are the contract every future backend inherits, so a change to them
 * silently changes behaviour for providers that never opted in.
 */
class TestProvider extends BaseHttpProvider {
	readonly id: ProviderId = 'llamacpp';
	capabilities: ProviderCapabilities = {
		displayName: 'Test Backend',
		embeddings: true,
		dedicatedEmbeddingModel: true,
		separateEmbeddingEndpoint: false,
		modelListing: true,
		embeddingModelSelection: 'curated',
		modelUnloadPolling: false,
		modelIdsHaveTags: false,
		modelFixedByServer: false,
	};

	embedCalls: {texts: string[]; isLastBatch: boolean}[] = [];
	embedImpl: (texts: string[]) => Promise<number[][]> = async texts => texts.map(() => [1]);
	streamImpl: (
		messages: ChatMessage[],
		onToken?: (token: string, fullText: string) => void,
	) => Promise<string> = async () => 'answer';
	lastSignal: AbortSignal | null = null;
	/** A snapshot of the messages each attempt was sent, in order. */
	calls: ChatMessage[][] = [];

	protected async embedBatch(texts: string[], isLastBatch: boolean): Promise<number[][]> {
		this.embedCalls.push({texts, isLastBatch});
		return this.embedImpl(texts);
	}

	/** The options each attempt was sent with. */
	requestOptions: ChatRequestOptions[] = [];

	protected async streamChat(
		messages: ChatMessage[],
		signal: AbortSignal,
		options: ChatRequestOptions = {},
	): Promise<string> {
		this.lastSignal = signal;
		this.calls.push(messages.map(m => ({...m})));
		this.requestOptions.push(options);
		return this.streamImpl(messages, options.onToken);
	}

	async getModelList(): Promise<string[]> {
		return [];
	}

	embeddingInstallHint(model: string): ModelInstallHint {
		return {summary: model, command: null};
	}

	/** Exposes the protected controller so an abort can be observed. */
	get controller(): AbortController | null {
		return this.abortController;
	}

	setRetryPolicy(retries: number, delayMs: number) {
		this.retryPolicy = {retries, delayMs};
	}

	setHistoryBudget(chars: number) {
		this.maxHistoryChars = chars;
	}
}

function makeProvider(config: Partial<ProviderConfig> = {}, shared: Partial<PluginSettings> = {}) {
	const settings: PluginSettings = {...defaultSettings(), ...shared};
	settings.provider = 'llamacpp';
	Object.assign(settings.providers.llamacpp, {url: 'http://test:1', chatModel: 'test-model'}, config);
	return {provider: new TestProvider({settings}), settings, config: settings.providers.llamacpp};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('config access', () => {
	it('reads settings live, so a change applies to the next request', () => {
		const {provider, config} = makeProvider();
		expect(provider.resolvedEmbeddingModel).toBe('test-model');

		config.chatModel = 'changed';

		expect(provider.resolvedEmbeddingModel).toBe('changed');
	});

	it('resolves the dedicated embedding model when enabled and set', () => {
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'embedder'});
		expect(provider.resolvedEmbeddingModel).toBe('embedder');
	});

	it('falls back to the chat model when the dedicated one is blank', () => {
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: ''});
		expect(provider.resolvedEmbeddingModel).toBe('test-model');
	});

	it('exposes a trimmed embedding endpoint', () => {
		const {provider} = makeProvider({url: 'http://test:1/'});
		expect(provider.embeddingEndpoint).toBe('http://test:1');
	});
});

describe('base defaults', () => {
	// Overridden by Ollama, which polls /api/ps. Every other backend has nothing to wait for, so
	// the default must resolve immediately rather than block an index build.
	it('reports the embedding model unloaded immediately', async () => {
		expect(await makeProvider().provider.waitForEmbeddingModelUnloaded()).toBe(true);
	});

	it('suggests no curated embedding models', () => {
		expect(makeProvider().provider.curatedEmbeddingModels()).toEqual([]);
	});

	// Ollama overrides this to ignore ":tag"; everyone else compares whole ids.
	it('compares model ids exactly', () => {
		const {provider} = makeProvider();

		expect(provider.isSameModel('a', 'a')).toBe(true);
		expect(provider.isSameModel('a', 'a:latest')).toBe(false);
	});

	it('displays a model id unchanged', () => {
		expect(makeProvider().provider.displayModelName('some/Model-GGUF')).toBe('some/Model-GGUF');
	});

	it('prefers a provider error detail over its message when formatting', () => {
		const {provider} = makeProvider();

		expect(provider.formatError(new ProviderError('wrapper text', {detail: 'server said no'})))
			.toBe('server said no');
	});

	it('falls back to the message when there is no detail', () => {
		expect(makeProvider().provider.formatError(new ProviderError('plain'))).toBe('plain');
	});

	it('stringifies a non-Error', () => {
		expect(makeProvider().provider.formatError(42)).toBe('42');
	});
});

describe('getEmbeddings', () => {
	it('refuses without issuing a request when the backend cannot embed', async () => {
		const {provider} = makeProvider();
		provider.capabilities = {...provider.capabilities, embeddings: false};

		await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
		expect(provider.embedCalls).toEqual([]);
	});

	it('batches at 32 and flags only the final batch', async () => {
		const {provider} = makeProvider();

		await provider.getEmbeddings(Array.from({length: 33}, (_, i) => `t${i}`));

		expect(provider.embedCalls).toHaveLength(2);
		expect(provider.embedCalls[0].isLastBatch).toBe(false);
		expect(provider.embedCalls[1].isLastBatch).toBe(true);
	});

	it('preserves order across batches', async () => {
		const {provider} = makeProvider();
		provider.embedImpl = async texts => texts.map(t => [Number(t)]);

		expect(await provider.getEmbeddings(['0', '1', '2'], 2)).toEqual([[0], [1], [2]]);
	});

	it('makes no call for an empty input', async () => {
		const {provider} = makeProvider();

		expect(await provider.getEmbeddings([])).toEqual([]);
		expect(provider.embedCalls).toEqual([]);
	});

	it('returns the single vector from getEmbedding', async () => {
		const {provider} = makeProvider();
		provider.embedImpl = async () => [[7, 8]];

		expect(await provider.getEmbedding('q')).toEqual([7, 8]);
	});
});

describe('retry policy', () => {
	// The general form of the old `/status 501/` check: a capability failure cannot be fixed by
	// asking again, so the permanent flag stops the retry loop for any provider.
	it('does not retry an error marked permanent', async () => {
		const {provider} = makeProvider();
		let calls = 0;
		provider.embedImpl = async () => {
			calls++;
			throw new ProviderError('nope', {permanent: true});
		};

		await expect(provider.getEmbeddings(['a'])).rejects.toThrow('nope');
		expect(calls).toBe(1);
	});

	it('retries an error not marked permanent', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		let calls = 0;
		provider.embedImpl = async () => {
			calls++;
			throw new ProviderError('transient');
		};

		const assertion = expect(provider.getEmbeddings(['a'])).rejects.toThrow('transient');
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;

		expect(calls).toBe(3);
	});

	// A backend that loads its model on first request needs a longer, sparser retry than Ollama.
	it('honours a provider-specific retry policy', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		provider.setRetryPolicy(1, 3000);
		let calls = 0;
		provider.streamImpl = async () => {
			calls++;
			throw new Error('cold start');
		};

		const assertion = expect(provider.sendQuestion('q')).rejects.toThrow('cold start');
		await vi.advanceTimersByTimeAsync(2999);
		expect(calls).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(calls).toBe(2);
	});
});

describe('sendQuestion', () => {
	it('returns the streamed answer', async () => {
		const {provider} = makeProvider();
		expect(await provider.sendQuestion('why?')).toBe('answer');
	});

	// Strict parity with /api/generate: the composed prompt (RAG block + question) is what the
	// model sees as the user turn. Splitting the RAG block out is a separate, later change.
	it('sends the composed prompt, untouched, as the user turn', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('CONTEXT\n\nQuestion: why?');

		expect(provider.calls[0]).toEqual([{role: 'user', content: 'CONTEXT\n\nQuestion: why?'}]);
	});
});

const user = (content: string): ChatMessage => ({role: 'user', content});
const assistant = (content: string): ChatMessage => ({role: 'assistant', content});

describe('conversation history', () => {
	it('sends only the question on the first turn', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('first');

		expect(provider.calls[0]).toEqual([user('first')]);
	});

	it('sends the prior turns ahead of the next question', async () => {
		const {provider} = makeProvider();
		provider.streamImpl = async messages => `answer to ${messages[messages.length - 1].content}`;

		await provider.sendQuestion('first');
		await provider.sendQuestion('second');

		expect(provider.calls[1]).toEqual([
			user('first'),
			assistant('answer to first'),
			user('second'),
		]);
	});

	it('clearContext starts a fresh conversation', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('first');
		provider.clearContext();
		await provider.sendQuestion('second');

		expect(provider.calls[1]).toEqual([user('second')]);
	});

	// withRetry calls the attempt up to three times. If the user turn were pushed into history
	// inside the attempt, two failures would leave the question in history three times.
	it('does not duplicate the question when an attempt is retried', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		let attempt = 0;
		provider.streamImpl = async () => {
			attempt++;
			if (attempt < 3) throw new Error('flaky');
			return 'finally';
		};

		const promise = provider.sendQuestion('first');
		await vi.advanceTimersByTimeAsync(2000);
		await promise;
		vi.useRealTimers();

		// Every attempt saw the same single-turn conversation...
		expect(provider.calls).toEqual([[user('first')], [user('first')], [user('first')]]);

		// ...and exactly one exchange was committed.
		provider.streamImpl = async () => 'ok';
		await provider.sendQuestion('second');
		expect(provider.calls[3]).toEqual([user('first'), assistant('finally'), user('second')]);
	});

	it('leaves history untouched when a turn fails outright', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		await provider.sendQuestion('first');
		provider.streamImpl = async () => {
			throw new Error('down');
		};

		const failed = expect(provider.sendQuestion('lost')).rejects.toThrow('down');
		await vi.advanceTimersByTimeAsync(2000);
		await failed;
		vi.useRealTimers();

		provider.streamImpl = async () => 'ok';
		await provider.sendQuestion('third');
		expect(provider.calls[provider.calls.length - 1]).toEqual([
			user('first'),
			assistant('answer'),
			user('third'),
		]);
	});

	// Closing the panel mid-answer must not leave a half-exchange behind.
	it('leaves history untouched when a turn is aborted', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('first');
		provider.streamImpl = async () => {
			throw new DOMException('cancelled', 'AbortError');
		};

		await expect(provider.sendQuestion('aborted')).rejects.toThrow('cancelled');

		provider.streamImpl = async () => 'ok';
		await provider.sendQuestion('third');
		expect(provider.calls[provider.calls.length - 1]).toEqual([
			user('first'),
			assistant('answer'),
			user('third'),
		]);
	});

	it('hands the provider a copy, so it cannot corrupt stored history', async () => {
		const {provider} = makeProvider();
		provider.streamImpl = async messages => {
			messages.push(user('injected'));
			messages[0].content = 'mutated';
			return 'answer';
		};

		await provider.sendQuestion('first');
		provider.streamImpl = async () => 'ok';
		await provider.sendQuestion('second');

		expect(provider.calls[1]).toEqual([user('first'), assistant('answer'), user('second')]);
	});

	describe('trimming', () => {
		// Every turn carries a RAG block, so an untrimmed history outgrows the model's context
		// within a few questions -- and the server then silently truncates the grounding.
		const pad = (label: string, size: number) => label + '.'.repeat(size - label.length);

		it('drops the oldest exchanges once the history outgrows its budget', async () => {
			const {provider} = makeProvider();
			provider.setHistoryBudget(100);
			provider.streamImpl = async () => pad('a', 20);

			await provider.sendQuestion(pad('q1', 20));
			await provider.sendQuestion(pad('q2', 20));
			await provider.sendQuestion(pad('q3', 20));

			// q3 (20) + the newest pair (40) + the next pair (40) = 100: both pairs fit exactly.
			expect(provider.calls[2].map(m => m.content.slice(0, 2))).toEqual(['q1', 'a.', 'q2', 'a.', 'q3']);

			await provider.sendQuestion(pad('q4', 20));
			// q4 + two pairs fits; the third-oldest pair (q1) no longer does.
			expect(provider.calls[3].map(m => m.content.slice(0, 2))).toEqual(['q2', 'a.', 'q3', 'a.', 'q4']);
		});

		// Dropping only the question or only the answer would leave the model reading a reply
		// to something it was never asked.
		it('drops whole exchanges, never half of one', async () => {
			const {provider} = makeProvider();
			provider.setHistoryBudget(50);
			provider.streamImpl = async () => pad('a', 20);

			await provider.sendQuestion(pad('q1', 20));
			await provider.sendQuestion(pad('q2', 20));

			// 20 (q2) + 40 (q1 pair) = 60 > 50, so the pair goes as a unit.
			expect(provider.calls[1].map(m => m.role)).toEqual(['user']);
		});

		// Stops at the first exchange that does not fit, rather than reaching past it for an
		// older, smaller one -- which would leave a gap in the conversation.
		it('keeps a contiguous run of the most recent exchanges', async () => {
			const {provider} = makeProvider();
			provider.setHistoryBudget(100);
			const answers = [pad('a1', 5), pad('a2', 90), pad('a3', 5)];
			provider.streamImpl = async () => answers.shift() ?? 'x';

			await provider.sendQuestion(pad('q1', 5));
			await provider.sendQuestion(pad('q2', 5));
			await provider.sendQuestion(pad('q3', 5));
			await provider.sendQuestion(pad('q4', 5));

			// q4 (5) + q3 pair (10) leaves 85; the q2 pair (95) does not fit, so q1's small pair
			// (10), which would, is never reached.
			expect(provider.calls[3].map(m => m.content.slice(0, 2))).toEqual(['q3', 'a3', 'q4']);
		});

		it('always sends the current question, even when it alone exceeds the budget', async () => {
			const {provider} = makeProvider();
			provider.setHistoryBudget(10);

			await provider.sendQuestion('first');
			await provider.sendQuestion(pad('huge', 500));

			expect(provider.calls[1]).toEqual([user(pad('huge', 500))]);
		});

		// Trimming applies to what is sent, not to what is remembered, so a later short question
		// can still see earlier turns that fit again.
		it('trims what is sent without discarding the stored history', async () => {
			const {provider} = makeProvider();
			provider.setHistoryBudget(60);
			provider.streamImpl = async () => pad('a', 10);

			await provider.sendQuestion(pad('q1', 10));
			await provider.sendQuestion(pad('q2', 55));
			await provider.sendQuestion(pad('q3', 10));

			expect(provider.calls[1].map(m => m.content.slice(0, 2))).toEqual(['q2']);
			// q3 (10) + q2 pair (65) does not fit, so still just the question; q1 is not
			// resurrected past the gap.
			expect(provider.calls[2].map(m => m.content.slice(0, 2))).toEqual(['q3']);
		});

		it('defaults to a budget large enough for several RAG-sized turns', async () => {
			const {provider} = makeProvider();
			const ragTurn = pad('q', 4000);
			provider.streamImpl = async () => pad('a', 500);

			await provider.sendQuestion(ragTurn);
			await provider.sendQuestion(ragTurn);

			expect(provider.calls[1]).toHaveLength(3);
		});
	});
});

describe('abort', () => {
	it('is safe with no request in flight', () => {
		expect(() => makeProvider().provider.abort()).not.toThrow();
	});

	it('clears the controller', () => {
		const {provider} = makeProvider();
		provider.streamImpl = async () => {
			provider.abort();
			return '';
		};

		expect(provider.controller).toBeNull();
	});

	// abort() nulls the controller, and sendQuestion reads that to skip a pending retry.
	it('skips a pending retry when an abort lands during the delay', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		let calls = 0;
		provider.streamImpl = async () => {
			calls++;
			throw new Error('boom');
		};

		const assertion = expect(provider.sendQuestion('q')).rejects.toThrow('boom');
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(1);

		provider.abort();
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;

		expect(calls).toBe(1);
	});
});

describe('optional lifecycle', () => {
	// ready()/dispose() exist for a future in-process provider that loads a model before use.
	// HTTP providers leave them undefined, and main.ts calls dispose with optional chaining.
	it('leaves ready and dispose undefined for an HTTP provider', () => {
		const provider: AiProvider = makeProvider().provider;

		expect(provider.ready).toBeUndefined();
		expect(provider.dispose).toBeUndefined();
	});
});

const system = (content: string): ChatMessage => ({role: 'system', content});

describe('per-turn context', () => {
	const pad = (label: string, size: number) => label + '.'.repeat(size - label.length);

	it('sends the context as a leading system message', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('why?', {context: 'EXCERPTS'});

		expect(provider.calls[0]).toEqual([system('EXCERPTS'), user('why?')]);
	});

	it.each([undefined, ''])('sends no system message when the context is %o', async context => {
		const {provider} = makeProvider();

		await provider.sendQuestion('why?', {context});

		expect(provider.calls[0]).toEqual([user('why?')]);
	});

	// The accumulation problem this fixes: when the excerpts rode inside the user turn, every
	// question's excerpts stayed in history for the rest of the chat.
	it('remembers the bare question, not the excerpts', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('first', {context: 'CTX1'});
		await provider.sendQuestion('second', {context: 'CTX2'});

		expect(provider.calls[1]).toEqual([
			system('CTX2'),
			user('first'),
			assistant('answer'),
			user('second'),
		]);
	});

	it('replaces the context each turn rather than accumulating it', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('first', {context: 'CTX1'});
		await provider.sendQuestion('second', {context: 'CTX2'});
		await provider.sendQuestion('third', {context: 'CTX3'});

		const sent = JSON.stringify(provider.calls[2]);
		expect(sent).not.toContain('CTX1');
		expect(sent).not.toContain('CTX2');
		expect(provider.calls[2].filter(m => m.role === 'system')).toEqual([system('CTX3')]);
	});

	// A follow-up with no fresh excerpts (a context-free turn, or retrieval finding nothing)
	// must not inherit the previous turn's.
	it('sends no system message on a turn without context, even after one with', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('first', {context: 'CTX1'});
		await provider.sendQuestion('second');

		expect(provider.calls[1]).toEqual([user('first'), assistant('answer'), user('second')]);
	});

	it('counts the context against the history budget', async () => {
		const {provider} = makeProvider();
		provider.setHistoryBudget(100);
		provider.streamImpl = async () => pad('a', 20);

		await provider.sendQuestion(pad('q1', 20));
		// 60 (context) + 20 (question) leaves 20: the 40-character exchange no longer fits.
		await provider.sendQuestion(pad('q2', 20), {context: pad('ctx', 60)});

		expect(provider.calls[1].map(m => m.role)).toEqual(['system', 'user']);
	});

	it('always sends the context and the question, even when together they exceed the budget', async () => {
		const {provider} = makeProvider();
		provider.setHistoryBudget(10);

		await provider.sendQuestion('first');
		await provider.sendQuestion('why?', {context: pad('ctx', 500)});

		expect(provider.calls[1]).toEqual([system(pad('ctx', 500)), user('why?')]);
	});
});

// A request outside the conversation: the parts of a staged summary, which must neither see the
// chat so far nor be remembered as part of it.
describe('complete', () => {
	it('sends the prompt alone, as one user message', async () => {
		const {provider} = makeProvider();

		expect(await provider.complete('Summarise this.')).toBe('answer');
		expect(provider.calls[0]).toEqual([user('Summarise this.')]);
	});

	it('does not send the conversation so far', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('earlier');

		await provider.complete('Summarise this.');

		expect(provider.calls[1]).toEqual([user('Summarise this.')]);
	});

	it('is not remembered in the conversation', async () => {
		const {provider} = makeProvider();
		await provider.complete('Summarise this.');

		await provider.sendQuestion('next');

		expect(provider.calls[1]).toEqual([user('next')]);
	});

	it('streams tokens to the caller', async () => {
		const {provider} = makeProvider();
		provider.streamImpl = async (_messages, onToken) => {
			onToken?.('an', 'an');
			onToken?.('swer', 'answer');
			return 'answer';
		};
		const seen: string[] = [];

		await provider.complete('p', {onToken: (_token, fullText) => seen.push(fullText)});

		expect(seen).toEqual(['an', 'answer']);
	});

	it('retries like a question', async () => {
		const {provider} = makeProvider();
		provider.setRetryPolicy(1, 0);
		let attempt = 0;
		provider.streamImpl = async () => {
			if (attempt++ === 0) throw new Error('flaky');
			return 'answer';
		};

		expect(await provider.complete('p')).toBe('answer');
		expect(provider.calls).toHaveLength(2);
	});

	// Stop on a staged summary aborts whichever part is in flight.
	it('can be aborted, skipping a pending retry', async () => {
		vi.useFakeTimers();
		const {provider} = makeProvider();
		let calls = 0;
		provider.streamImpl = async () => {
			calls++;
			throw new Error('boom');
		};

		const assertion = expect(provider.complete('p')).rejects.toThrow('boom');
		await vi.advanceTimersByTimeAsync(0);
		provider.abort();
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;

		expect(calls).toBe(1);
	});
});

describe('remember', () => {
	// A staged summary is remembered as the request and its result, not the text behind it.
	it('adds an exchange the next question carries', async () => {
		const {provider} = makeProvider();

		provider.remember('Summarize', 'The notes cover X.');
		await provider.sendQuestion('Tell me more about X');

		expect(provider.calls[0]).toEqual([
			user('Summarize'),
			assistant('The notes cover X.'),
			user('Tell me more about X'),
		]);
	});

	it('follows earlier turns', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('first');

		provider.remember('Summarize', 'summary');
		await provider.sendQuestion('next');

		expect(provider.calls[1]).toEqual([
			user('first'),
			assistant('answer'),
			user('Summarize'),
			assistant('summary'),
			user('next'),
		]);
	});

	it('is forgotten with the rest of the conversation', async () => {
		const {provider} = makeProvider();
		provider.remember('Summarize', 'summary');

		provider.clearContext();
		await provider.sendQuestion('next');

		expect(provider.calls[0]).toEqual([user('next')]);
	});
});

// The window decides how much conversation fits, not a fixed allowance.
describe('budgetChars', () => {
	it('fits the conversation to the request budget', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('q1');
		await provider.sendQuestion('q2');

		// The current question (2) and the latest exchange (2 + 6) fit 12; the one before does not.
		await provider.sendQuestion('q3', {budgetChars: 12});

		expect(provider.calls[2]).toEqual([user('q2'), assistant('answer'), user('q3')]);
	});

	it('counts the per-turn context against it', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('q1');

		await provider.sendQuestion('q2', {context: 'CTX', budgetChars: 12});

		expect(provider.calls[1]).toEqual([{role: 'system', content: 'CTX'}, user('q2')]);
	});

	it('keeps the usual allowance without one', async () => {
		const {provider} = makeProvider();
		await provider.sendQuestion('q1');
		await provider.sendQuestion('q2');

		await provider.sendQuestion('q3');

		expect(provider.calls[2]).toHaveLength(5);
	});
});

describe('complete options', () => {
	// A partial summary is capped, and its token count calibrates the next part's size.
	it('passes a length cap and a usage listener through to the backend', async () => {
		const {provider} = makeProvider();
		const onUsage = vi.fn();

		await provider.complete('p', {maxTokens: 512, onUsage});

		expect(provider.requestOptions[0]).toMatchObject({maxTokens: 512, onUsage});
	});

	it('sends a question uncapped', async () => {
		const {provider} = makeProvider();

		await provider.sendQuestion('q');

		expect(provider.requestOptions[0].maxTokens).toBeUndefined();
	});
});
