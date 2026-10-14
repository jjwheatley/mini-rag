import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	__requestBody,
	__resetRequestUrl,
	__setRequestUrlHandler,
	requestUrlCalls,
	RequestUrlParam,
} from '../stubs/obsidian';
import {OllamaProvider} from '../../src/providers/ollama-provider';
import {EmbeddingsUnsupportedError, ModelNotAvailableError, ProviderUnreachableError} from '../../src/providers/errors';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings, ProviderConfig} from '../../src/types';
import MiniRagPlugin from '../../main';
import {chunkEvery, errorResponse, installFetch, ndjson, nullBodyResponse, streamResponse} from '../helpers/stream';

const URL_BASE = 'http://localhost:11434';

/**
 * The provider only ever reads `settings`, so a ProviderRuntime-shaped object is enough — no
 * Plugin, no App, no vault. These tests were written against the pre-refactor wrapper with this
 * exact harness, and carried over unchanged apart from the class name.
 */
function makeProvider(
	config: Partial<ProviderConfig> = {},
	shared: Partial<PluginSettings> = {},
) {
	const settings: PluginSettings = {...defaultSettings(), ...shared};
	Object.assign(settings.providers.ollama, {url: URL_BASE, chatModel: 'chat-model'}, config);
	const runtime = {settings} as unknown as MiniRagPlugin;
	return {provider: new OllamaProvider(runtime), config: settings.providers.ollama, settings};
}

/** Routes by URL suffix so one handler can serve a test that touches several endpoints. */
function routeByPath(routes: Record<string, (request: RequestUrlParam) => any>) {
	__setRequestUrlHandler(request => {
		for (const [suffix, respond] of Object.entries(routes)) {
			if (request.url.endsWith(suffix)) return respond(request);
		}
		throw new Error(`unrouted request: ${request.url}`);
	});
}

const urls = () => requestUrlCalls.map(c => c.url);

beforeEach(() => {
	__resetRequestUrl();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('resolvedEmbeddingModel', () => {
	it('uses the chat model when a dedicated embedding model is not enabled', () => {
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: false, embeddingModel: 'nomic-embed-text'});
		expect(provider.resolvedEmbeddingModel).toBe('chat-model');
	});

	it('uses the embedding model when enabled and set', () => {
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});
		expect(provider.resolvedEmbeddingModel).toBe('nomic-embed-text');
	});

	it('falls back to the chat model when enabled but unset', () => {
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: ''});
		expect(provider.resolvedEmbeddingModel).toBe('chat-model');
	});
});

describe('getEmbeddings', () => {
	it('posts to /api/embed with the model and inputs', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1, 2], [3, 4]]}})});
		const {provider} = makeProvider();

		const result = await provider.getEmbeddings(['a', 'b']);

		expect(result).toEqual([[1, 2], [3, 4]]);
		expect(requestUrlCalls).toHaveLength(1);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/api/embed`);
		expect(requestUrlCalls[0].method).toBe('POST');
		expect(__requestBody(0)).toEqual({model: 'chat-model', input: ['a', 'b']});
	});

	it('omits keep_alive entirely when the chat model doubles as the embedding model', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1]]}})});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: false});

		await provider.getEmbeddings(['a']);

		expect(__requestBody(0)).not.toHaveProperty('keep_alive');
	});

	it('uses the dedicated embedding model in the request body', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1]]}})});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});

		await provider.getEmbeddings(['a']);

		expect(__requestBody(0).model).toBe('nomic-embed-text');
	});

	it('keeps a dedicated model resident between batches and releases it after the last', async () => {
		routeByPath({
			'/api/embed': request => {
				const count = (JSON.parse(String(request.body)).input as string[]).length;
				return {json: {embeddings: Array.from({length: count}, () => [1])}};
			},
		});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});

		const texts = Array.from({length: 33}, (_, i) => `t${i}`);
		const result = await provider.getEmbeddings(texts);

		expect(result).toHaveLength(33);
		expect(requestUrlCalls).toHaveLength(2);
		expect(__requestBody(0).input).toHaveLength(32);
		expect(__requestBody(0).keep_alive).toBe('5m');
		expect(__requestBody(1).input).toHaveLength(1);
		expect(__requestBody(1).keep_alive).toBe(0);
	});

	it('sends a single batch with keep_alive 0 when everything fits', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1]]}})});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});

		await provider.getEmbeddings(['only']);

		expect(requestUrlCalls).toHaveLength(1);
		expect(__requestBody(0).keep_alive).toBe(0);
	});

	it('honours a custom batch size', async () => {
		routeByPath({
			'/api/embed': request => {
				const count = (JSON.parse(String(request.body)).input as string[]).length;
				return {json: {embeddings: Array.from({length: count}, () => [1])}};
			},
		});
		const {provider} = makeProvider();

		await provider.getEmbeddings(['a', 'b', 'c'], 2);

		expect(requestUrlCalls).toHaveLength(2);
		expect(__requestBody(0).input).toEqual(['a', 'b']);
		expect(__requestBody(1).input).toEqual(['c']);
	});

	it('preserves order across batches', async () => {
		routeByPath({
			'/api/embed': request => {
				const input = JSON.parse(String(request.body)).input as string[];
				return {json: {embeddings: input.map(t => [Number(t)])}};
			},
		});
		const {provider} = makeProvider();

		const texts = Array.from({length: 5}, (_, i) => String(i));
		expect(await provider.getEmbeddings(texts, 2)).toEqual([[0], [1], [2], [3], [4]]);
	});

	it('makes no request for an empty input array', async () => {
		const {provider} = makeProvider();
		expect(await provider.getEmbeddings([])).toEqual([]);
		expect(requestUrlCalls).toHaveLength(0);
	});

	// An error field in a 200 body is still an error. "not found" is a capability problem, so it
	// resolves to a typed permanent error and is not retried -- three attempts would only delay
	// the install-hint panel by two seconds.
	it('classifies an error field in a 200 response, and does not retry it', async () => {
		routeByPath({'/api/embed': () => ({json: {error: 'model not found'}})});
		const {provider} = makeProvider();

		await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(ModelNotAvailableError);
		expect(requestUrlCalls).toHaveLength(1);
	});

	it('carries the server detail on a classified error', async () => {
		routeByPath({'/api/embed': () => ({json: {error: 'model not found'}})});
		const {provider} = makeProvider();

		await expect(provider.getEmbeddings(['a'])).rejects.toMatchObject({
			detail: 'model not found',
			permanent: true,
		});
	});

	// The V1 fallback signal: a chat model that cannot embed. This used to be a `/status 501/`
	// regex duplicated across three files; it is now one typed error that callers match on.
	it('raises a typed EmbeddingsUnsupportedError for a 501, without retrying', async () => {
		routeByPath({'/api/embed': () => ({status: 501, text: 'not implemented'})});
		const {provider} = makeProvider();

		await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
		expect(requestUrlCalls).toHaveLength(1);
	});

	// Ollama has shipped both 501 and 400 for this depending on version, so the text matters too.
	// A status-only check would silently break the fallback.
	it.each([
		[400, 'model does not support embeddings'],
		[500, 'this model does not support generate'],
		[200, 'embedding is not supported by this model'],
	])('detects unsupported embeddings from a %s carrying %s', async (status, text) => {
		routeByPath({'/api/embed': () => ({status, json: {error: text}})});
		const {provider} = makeProvider();

		await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
		expect(requestUrlCalls).toHaveLength(1);
	});

	it('names the model that could not embed', async () => {
		routeByPath({'/api/embed': () => ({status: 501, text: 'nope'})});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});

		await expect(provider.getEmbeddings(['a'])).rejects.toMatchObject({
			model: 'nomic-embed-text',
			providerId: 'ollama',
		});
	});

	it('retries an unclassified 500 up to three attempts', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/embed': () => ({status: 500, text: 'boom'})});
		const {provider} = makeProvider();

		const assertion = expect(provider.getEmbeddings(['a'])).rejects.toThrow('boom');
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(requestUrlCalls).toHaveLength(3);
	});

	it('keeps the status on an unclassified failure', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/embed': () => ({status: 500, text: 'boom'})});
		const {provider} = makeProvider();

		const assertion = expect(provider.getEmbeddings(['a'])).rejects.toMatchObject({
			status: 500,
			permanent: false,
		});
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});

	it('recovers when a retry succeeds', async () => {
		vi.useFakeTimers();
		let attempt = 0;
		routeByPath({
			'/api/embed': () => {
				attempt++;
				if (attempt === 1) return {status: 500, text: 'boom'};
				return {json: {embeddings: [[7]]}};
			},
		});
		const {provider} = makeProvider();

		const promise = provider.getEmbeddings(['a']);
		await vi.advanceTimersByTimeAsync(1000);

		expect(await promise).toEqual([[7]]);
		expect(requestUrlCalls).toHaveLength(2);
	});
});

describe('getEmbedding', () => {
	it('returns the first vector of a single-item batch', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[9, 8, 7]]}})});
		const {provider} = makeProvider();

		expect(await provider.getEmbedding('question')).toEqual([9, 8, 7]);
		expect(__requestBody(0).input).toEqual(['question']);
	});

	it('treats the single batch as the last, releasing a dedicated model', async () => {
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1]]}})});
		const {provider} = makeProvider({dedicatedEmbeddingEnabled: true, embeddingModel: 'nomic-embed-text'});

		await provider.getEmbedding('q');

		expect(__requestBody(0).keep_alive).toBe(0);
	});
});

describe('getModelList', () => {
	it('gives up at once when nothing is listening', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});
		const {provider} = makeProvider();

		await expect(provider.getModelList()).rejects.toBeInstanceOf(ProviderUnreachableError);
		expect(requestUrlCalls).toHaveLength(1);
	});

	it('gets /api/tags and returns names sorted', async () => {
		routeByPath({
			'/api/tags': () => ({json: {models: [{name: 'zephyr'}, {name: 'llama3'}, {name: 'Mistral'}]}}),
		});
		const {provider} = makeProvider();

		expect(await provider.getModelList()).toEqual(['llama3', 'Mistral', 'zephyr']);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/api/tags`);
		expect(requestUrlCalls[0].method).toBe('GET');
	});

	it('returns an empty list when models is absent', async () => {
		routeByPath({'/api/tags': () => ({json: {}})});
		const {provider} = makeProvider();

		expect(await provider.getModelList()).toEqual([]);
	});

	it('retries a failure', async () => {
		vi.useFakeTimers();
		let attempt = 0;
		routeByPath({
			'/api/tags': () => {
				attempt++;
				if (attempt === 1) return {status: 500, text: 'boom'};
				return {json: {models: [{name: 'llama3'}]}};
			},
		});
		const {provider} = makeProvider();

		const promise = provider.getModelList();
		await vi.advanceTimersByTimeAsync(1000);

		expect(await promise).toEqual(['llama3']);
	});
});

describe('waitForEmbeddingModelUnloaded', () => {
	it('returns true immediately when no model is resolved', async () => {
		const {provider} = makeProvider({chatModel: '', embeddingModel: ''});

		expect(await provider.waitForEmbeddingModelUnloaded()).toBe(true);
		expect(requestUrlCalls).toHaveLength(0);
	});

	it('returns true when the model is absent from /api/ps', async () => {
		routeByPath({'/api/ps': () => ({json: {models: [{name: 'other-model'}]}})});
		const {provider} = makeProvider();

		expect(await provider.waitForEmbeddingModelUnloaded()).toBe(true);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/api/ps`);
	});

	it('returns true when /api/ps reports no models at all', async () => {
		routeByPath({'/api/ps': () => ({json: {}})});
		const {provider} = makeProvider();

		expect(await provider.waitForEmbeddingModelUnloaded()).toBe(true);
	});

	it('treats an exact name match as still loaded', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/ps': () => ({json: {models: [{name: 'chat-model'}]}})});
		const {provider} = makeProvider();

		const promise = provider.waitForEmbeddingModelUnloaded(1000);
		await vi.advanceTimersByTimeAsync(1500);

		expect(await promise).toBe(false);
	});

	// Ollama reports "name:tag" in /api/ps while settings may hold the bare name.
	it('treats a name:tag prefix as still loaded', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/ps': () => ({json: {models: [{name: 'chat-model:latest'}]}})});
		const {provider} = makeProvider();

		const promise = provider.waitForEmbeddingModelUnloaded(1000);
		await vi.advanceTimersByTimeAsync(1500);

		expect(await promise).toBe(false);
	});

	it('does not treat a longer name without a colon as a match', async () => {
		routeByPath({'/api/ps': () => ({json: {models: [{name: 'chat-model-v2'}]}})});
		const {provider} = makeProvider();

		expect(await provider.waitForEmbeddingModelUnloaded()).toBe(true);
	});

	it('reads the model field when name is absent', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/ps': () => ({json: {models: [{model: 'chat-model'}]}})});
		const {provider} = makeProvider();

		const promise = provider.waitForEmbeddingModelUnloaded(1000);
		await vi.advanceTimersByTimeAsync(1500);

		expect(await promise).toBe(false);
	});

	it('treats a failing /api/ps as unloaded rather than propagating', async () => {
		routeByPath({'/api/ps': () => ({status: 500, text: 'boom'})});
		const {provider} = makeProvider();

		expect(await provider.waitForEmbeddingModelUnloaded()).toBe(true);
	});

	it('polls every 300ms until the deadline, then gives up', async () => {
		vi.useFakeTimers();
		routeByPath({'/api/ps': () => ({json: {models: [{name: 'chat-model'}]}})});
		const {provider} = makeProvider();

		const promise = provider.waitForEmbeddingModelUnloaded(1000);
		await vi.advanceTimersByTimeAsync(2000);

		expect(await promise).toBe(false);
		// Polls at 0, 300, 600 and 900ms: four attempts inside a 1000ms budget.
		expect(requestUrlCalls).toHaveLength(4);
	});

	it('stops polling as soon as the model disappears', async () => {
		vi.useFakeTimers();
		let poll = 0;
		routeByPath({
			'/api/ps': () => {
				poll++;
				return {json: {models: poll < 3 ? [{name: 'chat-model'}] : []}};
			},
		});
		const {provider} = makeProvider();

		const promise = provider.waitForEmbeddingModelUnloaded(10000);
		await vi.advanceTimersByTimeAsync(1000);

		expect(await promise).toBe(true);
		expect(requestUrlCalls).toHaveLength(3);
	});
});

describe('sendQuestion (streaming)', () => {
	// The legacy prompt/context fields are gone: /api/chat takes the conversation as messages.
	it('posts to /api/chat with the conversation, model, temperature and stream flag', async () => {
		const fetchSpy = installFetch(async () =>
			streamResponse(ndjson([{message: {role: 'assistant', content: 'hi'}, done: false}, {done: true}])),
		);
		const {provider} = makeProvider({}, {temperature: 0.42});

		await provider.sendQuestion('why?');

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe(`${URL_BASE}/api/chat`);
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			model: 'chat-model',
			messages: [{role: 'user', content: 'why?'}],
			options: {temperature: 0.42},
			stream: true,
		});
	});

	// Ollama's names for the same two things: num_predict, and prompt_eval_count on the last chunk.
	it('caps the answer when asked', async () => {
		const fetchSpy = installFetch(async () => streamResponse(ndjson([{message: {content: 'a'}}, {done: true}])));
		const {provider} = makeProvider({}, {temperature: 0.42});

		await provider.complete('p', {maxTokens: 512});

		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(String(init.body)).options).toEqual({temperature: 0.42, num_predict: 512});
	});

	it('reports the prompt\'s token count from the final chunk', async () => {
		installFetch(async () => streamResponse(ndjson([{message: {content: 'a'}}, {done: true, prompt_eval_count: 1534}])));
		const {provider} = makeProvider();
		const onUsage = vi.fn();

		await provider.complete('p', {onUsage});

		expect(onUsage).toHaveBeenCalledWith({promptTokens: 1534});
	});

	it('concatenates the message contents and returns the full text', async () => {
		installFetch(async () =>
			streamResponse(ndjson([
				{message: {content: 'Hello'}},
				{message: {content: ' '}},
				{message: {content: 'world'}},
				{done: true},
			])),
		);
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('Hello world');
	});

	it('calls onToken with each token and the accumulated text', async () => {
		installFetch(async () =>
			streamResponse(ndjson([{message: {content: 'a'}}, {message: {content: 'b'}}, {message: {content: 'c'}}, {done: true}])),
		);
		const {provider} = makeProvider();
		const seen: [string, string][] = [];

		await provider.sendQuestion('q', {onToken: (token, full) => seen.push([token, full])});

		// ChatWindow renders the second argument, so both are pinned.
		expect(seen).toEqual([['a', 'a'], ['b', 'ab'], ['c', 'abc']]);
	});

	it('does not call onToken for a chunk with no message content', async () => {
		installFetch(async () => streamResponse(ndjson([{done: false}, {done: true}])));
		const {provider} = makeProvider();
		const onToken = vi.fn();

		expect(await provider.sendQuestion('q', {onToken})).toBe('');
		expect(onToken).not.toHaveBeenCalled();
	});

	describe('NDJSON framing', () => {
		it('handles several complete lines in one byte chunk', async () => {
			installFetch(async () =>
				streamResponse(['{"message":{"content":"a"}}\n{"message":{"content":"b"}}\n{"done":true}\n']),
			);
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('ab');
		});

		// The buffer carry-over: a JSON object split across arbitrary byte boundaries.
		it('reassembles one JSON line split across many byte chunks', async () => {
			installFetch(async () =>
				streamResponse(ndjson([{message: {content: 'hello world'}}, {done: true}], chunkEvery(7))),
			);
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('hello world');
		});

		it('reassembles a stream split one byte at a time', async () => {
			installFetch(async () =>
				streamResponse(ndjson([{message: {content: 'abc'}}, {message: {content: 'def'}}, {done: true}], chunkEvery(1))),
			);
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('abcdef');
		});

		// The defensive flush: a final line with no terminating newline.
		it('processes a trailing line with no newline', async () => {
			installFetch(async () => streamResponse(['{"message":{"content":"a"}}\n{"message":{"content":"b"},"done":true}']));
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('ab');
		});

		it('ignores blank and whitespace-only lines', async () => {
			installFetch(async () => streamResponse(['\n  \n{"message":{"content":"a"}}\n\n{"done":true}\n\n']));
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('a');
		});

		it('handles an empty stream', async () => {
			installFetch(async () => streamResponse([]));
			const {provider} = makeProvider();

			expect(await provider.sendQuestion('q')).toBe('');
		});

		it('throws a truncated message for a non-JSON line', async () => {
			vi.useFakeTimers();
			installFetch(async () => streamResponse([`${'x'.repeat(200)}\n`]));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(
				`Ollama returned an unexpected response: ${'x'.repeat(120)}`,
			);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		// A malformed stream is retried: the throw happens after fetch resolved, so
		// abortController is still set and withRetry's shouldAbort reads false.
		it('retries a malformed stream three times', async () => {
			vi.useFakeTimers();
			const fetchSpy = installFetch(async () => streamResponse(['not json\n']));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(/unexpected response/);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(fetchSpy).toHaveBeenCalledTimes(3);
		});

		it('throws on an error field mid-stream', async () => {
			vi.useFakeTimers();
			installFetch(async () =>
				streamResponse(ndjson([{message: {content: 'a'}}, {error: 'model crashed'}])),
			);
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow('model crashed');
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('routes a mid-stream CUDA error through the GPU guidance', async () => {
			vi.useFakeTimers();
			installFetch(async () => streamResponse(ndjson([{error: 'cuda init failed'}])));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(
				/could not run the model on your GPU/,
			);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});
	});

	describe('conversation history', () => {
		/** Answers each request with "answer N", counting from 1. */
		const numberedAnswers = () => {
			let n = 0;
			return installFetch(async () => {
				n++;
				return streamResponse(ndjson([{message: {role: 'assistant', content: `answer ${n}`}}, {done: true}]));
			});
		};
		const messagesOf = (spy: ReturnType<typeof installFetch>, call: number) =>
			JSON.parse(String((spy.mock.calls[call][1] as RequestInit).body)).messages;

		it('sends the earlier exchange ahead of a follow-up question', async () => {
			const fetchSpy = numberedAnswers();
			const {provider} = makeProvider();

			await provider.sendQuestion('first');
			await provider.sendQuestion('second');

			expect(messagesOf(fetchSpy, 1)).toEqual([
				{role: 'user', content: 'first'},
				{role: 'assistant', content: 'answer 1'},
				{role: 'user', content: 'second'},
			]);
		});

		it('clearContext starts a fresh conversation', async () => {
			const fetchSpy = numberedAnswers();
			const {provider} = makeProvider();

			await provider.sendQuestion('first');
			provider.clearContext();
			await provider.sendQuestion('second');

			expect(messagesOf(fetchSpy, 1)).toEqual([{role: 'user', content: 'second'}]);
		});

		it('sends per-turn context as a leading system message', async () => {
			const fetchSpy = numberedAnswers();
			const {provider} = makeProvider();

			await provider.sendQuestion('why?', {context: 'EXCERPTS'});

			expect(messagesOf(fetchSpy, 0)).toEqual([
				{role: 'system', content: 'EXCERPTS'},
				{role: 'user', content: 'why?'},
			]);
		});

		// An older server may still send /api/generate's token array; it must not leak back in.
		it('ignores a stray legacy context field in the stream', async () => {
			const fetchSpy = installFetch(async () =>
				streamResponse(ndjson([{message: {content: 'a'}}, {done: true, context: [5, 6]}])),
			);
			const {provider} = makeProvider();

			await provider.sendQuestion('first');
			await provider.sendQuestion('second');

			const body = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
			expect(body).not.toHaveProperty('context');
			expect(body).not.toHaveProperty('prompt');
		});

		it('does not record an exchange whose stream failed', async () => {
			vi.useFakeTimers();
			let n = 0;
			const fetchSpy = installFetch(async () => {
				n++;
				// Call 1 succeeds; calls 2-4 (one turn, three attempts) fail; call 5 succeeds.
				if (n >= 2 && n <= 4) return errorResponse(503, 'overloaded');
				return streamResponse(ndjson([{message: {content: `answer ${n}`}}, {done: true}]));
			});
			const {provider} = makeProvider();

			await provider.sendQuestion('first');
			const failed = expect(provider.sendQuestion('lost')).rejects.toThrow('overloaded');
			await vi.advanceTimersByTimeAsync(2000);
			await failed;
			await provider.sendQuestion('third');

			expect(messagesOf(fetchSpy, 4)).toEqual([
				{role: 'user', content: 'first'},
				{role: 'assistant', content: 'answer 1'},
				{role: 'user', content: 'third'},
			]);
		});
	});

	describe('HTTP failures', () => {
		// The raised error keeps the status, which is what a log wants; formatError() strips the
		// prefix at the UI boundary, which is what a user wants. Both halves are pinned because
		// they live in different places and have to stay consistent.
		it('raises a non-ok response with its status and body', async () => {
			vi.useFakeTimers();
			installFetch(async () => errorResponse(503, 'server overloaded'));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(
				'Ollama request failed (503): server overloaded',
			);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('formats that error down to the server text for display', () => {
			const {provider} = makeProvider();

			expect(provider.formatError(new Error('Ollama request failed (503): server overloaded')))
				.toBe('server overloaded');
		});

		// With no body there is no colon, so the strip regex does not match and the prefix
		// survives. The asymmetry is real: the status code reaches the user only when the
		// server said nothing.
		it('keeps the prefix when the error body is empty', async () => {
			vi.useFakeTimers();
			installFetch(async () => errorResponse(503, ''));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(
				'Ollama request failed (503)',
			);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('reports an empty response body', async () => {
			vi.useFakeTimers();
			installFetch(async () => nullBodyResponse());
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(
				'The server returned an empty response body.',
			);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('retries a transport failure and succeeds on the second attempt', async () => {
			vi.useFakeTimers();
			let attempt = 0;
			const fetchSpy = installFetch(async () => {
				attempt++;
				if (attempt === 1) throw new Error('ECONNREFUSED');
				return streamResponse(ndjson([{message: {content: 'recovered'}}, {done: true}]));
			});
			const {provider} = makeProvider();

			const promise = provider.sendQuestion('q');
			await vi.advanceTimersByTimeAsync(1000);

			expect(await promise).toBe('recovered');
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});

		it('makes three attempts before giving up', async () => {
			vi.useFakeTimers();
			const fetchSpy = installFetch(async () => {
				throw new Error('ECONNREFUSED');
			});
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow('ECONNREFUSED');
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(fetchSpy).toHaveBeenCalledTimes(3);
		});
	});

	describe('abort', () => {
		it('passes an abort signal with the request', async () => {
			const fetchSpy = installFetch(async () => streamResponse(ndjson([{done: true}])));
			const {provider} = makeProvider();

			await provider.sendQuestion('q');

			expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
		});

		// Closing the panel mid-stream: the read rejects, and the abort must not be retried.
		it('propagates a mid-stream abort without retrying', async () => {
			const encoder = new TextEncoder();
			const fetchSpy = installFetch(async (_url, init) => {
				const signal = init.signal as AbortSignal;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode('{"message":{"content":"partial"}}\n'));
						signal.addEventListener('abort', () =>
							controller.error(new DOMException('aborted', 'AbortError')),
						);
					},
				});
				return {ok: true, status: 200, body, text: async () => ''} as unknown as Response;
			});
			const {provider} = makeProvider();

			const promise = provider.sendQuestion('q', {
				onToken: () => provider.abort(),
			});

			await expect(promise).rejects.toThrow('aborted');
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it('does not retry when fetch itself rejects with an AbortError', async () => {
			const fetchSpy = installFetch(async () => {
				throw new DOMException('aborted', 'AbortError');
			});
			const {provider} = makeProvider();

			await expect(provider.sendQuestion('q')).rejects.toThrow('aborted');
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it('is safe to call with no request in flight', () => {
			const {provider} = makeProvider();
			expect(() => provider.abort()).not.toThrow();
		});

		// abort() nulls the controller, and withRetry reads that to skip a pending retry.
		it('skips a pending retry when abort lands during the delay', async () => {
			vi.useFakeTimers();
			const fetchSpy = installFetch(async () => {
				throw new Error('ECONNREFUSED');
			});
			const {provider} = makeProvider();

			const promise = provider.sendQuestion('q');
			const assertion = expect(promise).rejects.toThrow('ECONNREFUSED');

			await vi.advanceTimersByTimeAsync(0);
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			provider.abort();
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});
	});

	it('reads the URL from settings at call time', async () => {
		const fetchSpy = installFetch(async () => streamResponse(ndjson([{done: true}])));
		const {provider, config} = makeProvider();

		config.url = 'http://127.0.0.1:9999';
		await provider.sendQuestion('q');

		expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/chat');
	});
});

describe('endpoint construction', () => {
	it('uses the configured base URL for every endpoint', async () => {
		const {provider} = makeProvider({url: 'http://example.test:1234'});
		routeByPath({
			'/api/embed': () => ({json: {embeddings: [[1]]}}),
			'/api/tags': () => ({json: {models: []}}),
			'/api/ps': () => ({json: {models: []}}),
		});

		await provider.getEmbeddings(['a']);
		await provider.getModelList();
		await provider.waitForEmbeddingModelUnloaded();

		expect(urls()).toEqual([
			'http://example.test:1234/api/embed',
			'http://example.test:1234/api/tags',
			'http://example.test:1234/api/ps',
		]);
	});

	// Previously a URL ending in "/" produced "//api/tags"; trimSlash now normalises it.
	it('normalises a trailing slash on the base URL', async () => {
		const {provider} = makeProvider({url: `${URL_BASE}/`});
		routeByPath({'/api/tags': () => ({json: {models: []}})});

		await provider.getModelList();

		expect(urls()[0]).toBe(`${URL_BASE}/api/tags`);
	});

	it('falls back to the main URL for embeddings when no embedding URL is set', async () => {
		const {provider} = makeProvider({url: 'http://main.test:1', embeddingUrl: ''});
		routeByPath({'/api/embed': () => ({json: {embeddings: [[1]]}})});

		await provider.getEmbeddings(['a']);

		expect(urls()[0]).toBe('http://main.test:1/api/embed');
	});

	// llama-server serves one model per process, so embeddings may live on a second instance.
	it('sends embeddings to the dedicated embedding URL when one is set', async () => {
		const {provider} = makeProvider({
			url: 'http://main.test:1',
			embeddingUrl: 'http://embed.test:2',
			dedicatedEmbeddingEnabled: true,
		});
		routeByPath({
			'/api/embed': () => ({json: {embeddings: [[1]]}}),
			'/api/tags': () => ({json: {models: []}}),
		});

		await provider.getEmbeddings(['a']);
		await provider.getModelList();

		expect(urls()).toEqual(['http://embed.test:2/api/embed', 'http://main.test:1/api/tags']);
	});
});

describe('formatError', () => {
	const format = (error: unknown) => makeProvider().provider.formatError(error);

	const GPU_HEADLINE = 'Ollama could not run the model on your GPU (CUDA error).';

	it.each(['cuda', 'CUDA', 'gpu', 'vulkan', 'shared object initialization'])(
		'returns GPU guidance when the detail mentions %s',
		keyword => {
			const output = format(new Error(`failure: ${keyword} exploded`));
			expect(output).toContain(GPU_HEADLINE);
			expect(output).toContain('Force CPU mode: set OLLAMA_NO_GPU=1, then restart Ollama');
			expect(output).toContain(`Details: failure: ${keyword} exploded`);
		},
	);

	it('extracts the error field from an embedded JSON blob', () => {
		const output = format(
			new Error('Ollama request failed (404): {"error":"model \'nope\' not found"}'),
		);
		expect(output).toBe("model 'nope' not found");
	});

	it('strips the "Ollama request failed (NNN):" prefix when there is no JSON', () => {
		expect(format(new Error('Ollama request failed (501): unsupported'))).toBe(
			'unsupported',
		);
	});

	it('strips the prefix case-insensitively', () => {
		expect(format(new Error('ollama REQUEST FAILED (500): boom'))).toBe('boom');
	});

	it('falls back to the raw message when the embedded JSON has no error field', () => {
		const output = format(new Error('Ollama request failed (500): {"detail":"nope"}'));
		expect(output).toBe('{"detail":"nope"}');
	});

	it('falls back to the raw message when the braces are not valid JSON', () => {
		const output = format(new Error('Ollama request failed (500): {not json}'));
		expect(output).toBe('{not json}');
	});

	it('passes an unrecognised message straight through', () => {
		expect(format(new Error('something went wrong'))).toBe('something went wrong');
	});

	it('accepts a bare string', () => {
		expect(format('plain failure')).toBe('plain failure');
	});

	it('stringifies a non-Error, non-string value', () => {
		expect(format(42)).toBe('42');
		expect(format(null)).toBe('null');
	});

	it('returns the original message when stripping leaves nothing', () => {
		expect(format(new Error('Ollama request failed (500): '))).toBe(
			'Ollama request failed (500): ',
		);
	});

	it('prefers GPU guidance over a plain JSON extraction', () => {
		const output = format(
			new Error('Ollama request failed (500): {"error":"cuda init failed"}'),
		);
		expect(output).toContain(GPU_HEADLINE);
		expect(output).toContain('Details: cuda init failed');
	});
});

describe('capabilities', () => {
	it('declares the Ollama feature set the settings UI branches on', () => {
		expect(makeProvider().provider.capabilities).toEqual({
			displayName: 'Ollama',
			embeddings: true,
			dedicatedEmbeddingModel: true,
			// Ollama serves many models from one endpoint, unlike llama-server.
			separateEmbeddingEndpoint: false,
			modelListing: true,
			embeddingModelSelection: 'curated',
			// The VRAM unload dance is Ollama-only.
			modelUnloadPolling: true,
			modelIdsHaveTags: true,
			// Ollama loads whichever model a request names.
			modelFixedByServer: false,
		});
	});

	it('identifies itself as ollama', () => {
		expect(makeProvider().provider.id).toBe('ollama');
	});
});

describe('model naming', () => {
	it.each([
		['nomic-embed-text', 'nomic-embed-text:latest'],
		['llama3:8b', 'llama3:70b'],
		['llama3', 'llama3'],
	])('treats %s and %s as the same model', (a, b) => {
		expect(makeProvider().provider.isSameModel(a, b)).toBe(true);
	});

	it.each([
		['llama3', 'mistral'],
		['nomic-embed-text', 'nomic-embed'],
	])('treats %s and %s as different models', (a, b) => {
		expect(makeProvider().provider.isSameModel(a, b)).toBe(false);
	});

	it.each([
		['llama3.1:8b', 'Llama3.1'],
		['nomic-embed-text', 'Nomic-embed-text'],
		['Mistral:latest', 'Mistral'],
	])('displays %s as %s', (id, expected) => {
		expect(makeProvider().provider.displayModelName(id)).toBe(expected);
	});

	it('leaves an empty model name alone', () => {
		expect(makeProvider().provider.displayModelName('')).toBe('');
	});
});

describe('curatedEmbeddingModels', () => {
	it('suggests known Ollama embedding models', () => {
		const models = makeProvider().provider.curatedEmbeddingModels();

		expect(models).toContain('nomic-embed-text');
		expect(models).toContain('bge-m3');
		expect(models).toEqual([...models].sort());
	});

	// The settings tab renders these into a dropdown; handing out the live array would let it
	// mutate the provider's own list.
	it('returns a copy', () => {
		const {provider} = makeProvider();
		provider.curatedEmbeddingModels().push('injected');

		expect(provider.curatedEmbeddingModels()).not.toContain('injected');
	});
});

describe('embeddingInstallHint', () => {
	// There is nothing to pull until a model is chosen.
	it('asks for a model to be chosen rather than offer a bare ollama pull', () => {
		const hint = makeProvider().provider.embeddingInstallHint('');

		expect(hint.command).toBeNull();
		expect(hint.summary).toBe('Choose an embedding model above.');
	});

	it('offers a copyable ollama pull command', () => {
		const hint = makeProvider().provider.embeddingInstallHint('nomic-embed-text');

		expect(hint.command).toBe('ollama pull nomic-embed-text');
		expect(hint.summary).toBe('Mini-RAG expected to find "nomic-embed-text" in Ollama.');
		// ollama pull finishes by itself, so any terminal will do.
		expect(hint.commandNote).toBeUndefined();
	});
});

// Ollama lists every model it has, and the settings tab says to pull one when it lists none.
describe('running models', () => {
	// Ollama loads whichever model a request names, so the chosen model is the one in use.
	it('has nothing to identify', () => {
		const {provider} = makeProvider();

		expect('identifyRunningModels' in provider).toBe(false);
		expect('runningChatModel' in provider).toBe(false);
	});
});

describe('chatModelInstallHint', () => {
	it('is not offered', () => {
		expect('chatModelInstallHint' in makeProvider().provider).toBe(false);
	});
});

describe('contextLength', () => {
	// Ollama trims an over-long prompt itself, so there is no limit for Mini-RAG to respect.
	it('is not reported', () => {
		expect('contextLength' in makeProvider().provider).toBe(false);
	});
});

describe('embeddingEndpoint', () => {
	it('is exposed for the embedding cache key', () => {
		expect(makeProvider({url: 'http://h:1/'}).provider.embeddingEndpoint).toBe('http://h:1');
	});

	it('prefers a dedicated embedding URL', () => {
		expect(makeProvider({url: 'http://h:1', embeddingUrl: 'http://e:2', dedicatedEmbeddingEnabled: true})
			.provider.embeddingEndpoint).toBe('http://e:2');
	});
});
