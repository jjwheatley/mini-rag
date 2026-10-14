import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	__requestBody,
	__resetRequestUrl,
	__setRequestUrlHandler,
	requestUrlCalls,
	RequestUrlParam,
} from '../stubs/obsidian';
import {OpenAiCompatibleProvider} from '../../src/providers/openai-compatible-provider';
import {
	EmbeddingsUnsupportedError,
	ModelNotAvailableError,
	ProviderError,
} from '../../src/providers/errors';
import {ModelInstallHint, ProviderCapabilities, ProviderId} from '../../src/providers/types';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings, ProviderConfig} from '../../src/types';
import {chunkEvery, errorResponse, installFetch, sse, streamResponse} from '../helpers/stream';

const URL_BASE = 'http://localhost:8080';

/**
 * The shared OpenAI-compatible behaviour, exercised through the thinnest possible subclass.
 * llama.cpp adds only its model listing and setup hints on top of this.
 */
class TestOpenAiProvider extends OpenAiCompatibleProvider {
	readonly id: ProviderId = 'llamacpp';
	readonly capabilities: ProviderCapabilities = {
		displayName: 'Test OpenAI-compatible',
		embeddings: true,
		dedicatedEmbeddingModel: true,
		separateEmbeddingEndpoint: true,
		modelListing: true,
		embeddingModelSelection: 'curated',
		modelUnloadPolling: false,
		modelIdsHaveTags: false,
		modelFixedByServer: false,
	};

	embeddingInstallHint(model: string): ModelInstallHint {
		return {summary: model, command: null};
	}

	protected gpuTroubleshooting() {
		return {server: 'Test server', tips: ['Try something else']};
	}
}

function makeProvider(config: Partial<ProviderConfig> = {}, shared: Partial<PluginSettings> = {}) {
	const settings: PluginSettings = {...defaultSettings(), ...shared};
	settings.provider = 'llamacpp';
	Object.assign(settings.providers.llamacpp, {url: URL_BASE, chatModel: 'chat-model'}, config);
	return {provider: new TestOpenAiProvider({settings}), config: settings.providers.llamacpp};
}

/** One streamed completion chunk. Omitting content gives the role-only opening delta. */
const delta = (content?: string) => ({
	choices: [{index: 0, delta: content === undefined ? {role: 'assistant'} : {content}, finish_reason: null}],
});

const bodyOf = (spy: ReturnType<typeof installFetch>, call = 0) =>
	JSON.parse(String((spy.mock.calls[call][1] as RequestInit).body));

beforeEach(() => {
	__resetRequestUrl();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('chat streaming', () => {
	it('posts to /v1/chat/completions with the model, messages, temperature and stream flags', async () => {
		const spy = installFetch(async () => streamResponse(sse([delta('hi'), '[DONE]'])));
		const {provider} = makeProvider({}, {temperature: 0.3});

		await provider.sendQuestion('why?');

		expect(spy.mock.calls[0][0]).toBe(`${URL_BASE}/v1/chat/completions`);
		// OpenAI puts temperature at the top level, unlike Ollama's options object.
		expect(bodyOf(spy)).toEqual({
			model: 'chat-model',
			messages: [{role: 'user', content: 'why?'}],
			temperature: 0.3,
			stream: true,
			// Asks for the token count with the stream, which sizes a staged summary's parts.
			stream_options: {include_usage: true},
		});
	});

	describe('request options', () => {
		it('caps the answer when asked', async () => {
			const spy = installFetch(async () => streamResponse(sse([delta('hi'), '[DONE]'])));
			const {provider} = makeProvider();

			await provider.complete('p', {maxTokens: 512});

			expect(bodyOf(spy).max_tokens).toBe(512);
		});

		it('reports the prompt\'s token count from the closing usage chunk', async () => {
			installFetch(async () => streamResponse(sse([
				delta('a'),
				{usage: {prompt_tokens: 1534, completion_tokens: 9}, choices: []},
				'[DONE]',
			])));
			const {provider} = makeProvider();
			const onUsage = vi.fn();

			await provider.complete('p', {onUsage});

			expect(onUsage).toHaveBeenCalledWith({promptTokens: 1534});
		});

		// llama-server reports its own timings, with or without the usage chunk.
		it('reads llama-server\'s timings when there is no usage chunk', async () => {
			installFetch(async () => streamResponse(sse([
				{choices: [{delta: {content: 'a'}}], timings: {prompt_n: 812}},
				'[DONE]',
			])));
			const {provider} = makeProvider();
			const onUsage = vi.fn();

			await provider.complete('p', {onUsage});

			expect(onUsage).toHaveBeenCalledWith({promptTokens: 812});
		});

		it('reports nothing when the server does not say', async () => {
			installFetch(async () => streamResponse(sse([delta('a'), '[DONE]'])));
			const {provider} = makeProvider();
			const onUsage = vi.fn();

			await provider.complete('p', {onUsage});

			expect(onUsage).not.toHaveBeenCalled();
		});
	});

	it('carries per-turn context through as the system message', async () => {
		const spy = installFetch(async () => streamResponse(sse([delta('ok'), '[DONE]'])));
		const {provider} = makeProvider();

		await provider.sendQuestion('why?', {context: 'EXCERPTS'});

		expect(bodyOf(spy).messages).toEqual([
			{role: 'system', content: 'EXCERPTS'},
			{role: 'user', content: 'why?'},
		]);
	});

	it('concatenates the deltas and reports each token', async () => {
		installFetch(async () => streamResponse(sse([delta('Hel'), delta('lo'), delta('!'), '[DONE]'])));
		const {provider} = makeProvider();
		const seen: [string, string][] = [];

		const answer = await provider.sendQuestion('q', {onToken: (t, full) => seen.push([t, full])});

		expect(answer).toBe('Hello!');
		expect(seen).toEqual([['Hel', 'Hel'], ['lo', 'Hello'], ['!', 'Hello!']]);
	});

	// The first chunk announces the role and carries no text.
	it('skips a role-only opening delta', async () => {
		installFetch(async () => streamResponse(sse([delta(), delta('text'), '[DONE]'])));
		const {provider} = makeProvider();
		const onToken = vi.fn();

		expect(await provider.sendQuestion('q', {onToken})).toBe('text');
		expect(onToken).toHaveBeenCalledTimes(1);
	});

	it('skips a chunk with no choices, such as a final usage report', async () => {
		installFetch(async () => streamResponse(sse([delta('a'), {usage: {total_tokens: 9}, choices: []}, '[DONE]'])));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('a');
	});

	it('treats [DONE] as the end of the stream, not as JSON', async () => {
		installFetch(async () => streamResponse(sse([delta('a'), '[DONE]'])));
		const {provider} = makeProvider();

		await expect(provider.sendQuestion('q')).resolves.toBe('a');
	});

	it('ignores anything after [DONE]', async () => {
		installFetch(async () => streamResponse([...sse([delta('a'), '[DONE]']), 'data: not json\n\n']));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('a');
	});

	it('ignores SSE comments, event lines and blank lines', async () => {
		installFetch(async () => streamResponse([
			': keep-alive\n\n',
			'event: message\n',
			`data: ${JSON.stringify(delta('a'))}\n\n`,
			'\n\n',
			'data: [DONE]\n\n',
		]));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('a');
	});

	it('accepts data lines with no space after the colon', async () => {
		installFetch(async () => streamResponse([`data:${JSON.stringify(delta('a'))}\n\ndata:[DONE]\n\n`]));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('a');
	});

	it('reassembles events split across byte chunks', async () => {
		installFetch(async () => streamResponse(sse([delta('hello'), delta(' world'), '[DONE]'], chunkEvery(5))));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('hello world');
	});

	// A server that never sends [DONE] still ends the answer when the body closes.
	it('finishes cleanly when the stream closes without [DONE]', async () => {
		installFetch(async () => streamResponse(sse([delta('a'), delta('b')])));
		const {provider} = makeProvider();

		expect(await provider.sendQuestion('q')).toBe('ab');
	});

	it('passes an abort signal', async () => {
		const spy = installFetch(async () => streamResponse(sse(['[DONE]'])));
		const {provider} = makeProvider();

		await provider.sendQuestion('q');

		expect((spy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
	});

	describe('failures', () => {
		it('raises a data line that is not JSON', async () => {
			vi.useFakeTimers();
			installFetch(async () => streamResponse(['data: {not json\n\n']));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow(/unexpected response/);
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('raises an error object sent mid-stream', async () => {
			vi.useFakeTimers();
			installFetch(async () => streamResponse(sse([delta('a'), {error: {message: 'model crashed'}}])));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow('model crashed');
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		it('raises a server error with its status and detail, and retries it', async () => {
			vi.useFakeTimers();
			const spy = installFetch(async () =>
				errorResponse(500, JSON.stringify({error: {message: 'out of memory'}})),
			);
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toMatchObject({
				status: 500,
				detail: 'out of memory',
			});
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(spy).toHaveBeenCalledTimes(3);
		});

		it('reads a plain-text error body', async () => {
			vi.useFakeTimers();
			installFetch(async () => errorResponse(500, 'plain failure'));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toMatchObject({detail: 'plain failure'});
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;
		});

		// A bad request -- an over-long context, an unknown model -- fails the same way every
		// time, so retrying only delays the message by two seconds.
		it.each([400, 401, 404, 422])('does not retry a %s client error', async status => {
			const spy = installFetch(async () => errorResponse(status, JSON.stringify({error: {message: 'nope'}})));
			const {provider} = makeProvider();

			await expect(provider.sendQuestion('q')).rejects.toBeInstanceOf(ProviderError);
			expect(spy).toHaveBeenCalledTimes(1);
		});

		// Timeouts and rate limits are client-side statuses that do clear up on their own.
		it.each([408, 429])('does retry a %s', async status => {
			vi.useFakeTimers();
			const spy = installFetch(async () => errorResponse(status, 'busy'));
			const {provider} = makeProvider();

			const assertion = expect(provider.sendQuestion('q')).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(spy).toHaveBeenCalledTimes(3);
		});
	});
});

describe('embeddings', () => {
	/** Answers /v1/embeddings with one vector per input, [position] each, in request order. */
	const echoEmbeddings = (shape: (i: number) => unknown = i => [i]) =>
		__setRequestUrlHandler((request: RequestUrlParam) => {
			const input = JSON.parse(String(request.body)).input as string[];
			return {json: {object: 'list', data: input.map((_, i) => ({object: 'embedding', index: i, embedding: shape(i)}))}};
		});

	it('posts the model and inputs to /v1/embeddings', async () => {
		echoEmbeddings();
		const {provider} = makeProvider();

		expect(await provider.getEmbeddings(['a', 'b'])).toEqual([[0], [1]]);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/v1/embeddings`);
		expect(__requestBody(0)).toEqual({model: 'chat-model', input: ['a', 'b']});
	});

	// llama-server serves one model per process, so embeddings may live on a second instance.
	it('sends embeddings to the dedicated embedding URL when set', async () => {
		echoEmbeddings();
		const {provider} = makeProvider({
			embeddingUrl: 'http://localhost:8081',
			dedicatedEmbeddingEnabled: true,
			embeddingModel: 'embedder',
		});

		await provider.getEmbeddings(['a']);

		expect(requestUrlCalls[0].url).toBe('http://localhost:8081/v1/embeddings');
		expect(__requestBody(0).model).toBe('embedder');
	});

	// The index builder walks the result positionally, so an out-of-order response would attach
	// each vector to the wrong chunk -- silently degrading retrieval with no error anywhere.
	it('orders the vectors by index, not by arrival', async () => {
		__setRequestUrlHandler(() => ({
			json: {data: [
				{index: 2, embedding: [2]},
				{index: 0, embedding: [0]},
				{index: 1, embedding: [1]},
			]},
		}));
		const {provider} = makeProvider();

		expect(await provider.getEmbeddings(['a', 'b', 'c'])).toEqual([[0], [1], [2]]);
	});

	it('keeps arrival order when the server omits indices', async () => {
		__setRequestUrlHandler(() => ({json: {data: [{embedding: [5]}, {embedding: [6]}]}}));
		const {provider} = makeProvider();

		expect(await provider.getEmbeddings(['a', 'b'])).toEqual([[5], [6]]);
	});

	// llama-server started with --pooling none returns one vector per token rather than per
	// input. Mean-pooling them gives a usable sentence embedding.
	it('mean-pools per-token vectors into one', async () => {
		__setRequestUrlHandler(() => ({json: {data: [{index: 0, embedding: [[1, 2], [3, 4], [5, 6]]}]}}));
		const {provider} = makeProvider();

		expect(await provider.getEmbeddings(['a'])).toEqual([[3, 4]]);
	});

	it('batches large inputs', async () => {
		echoEmbeddings();
		const {provider} = makeProvider();

		const result = await provider.getEmbeddings(Array.from({length: 40}, (_, i) => `t${i}`));

		expect(result).toHaveLength(40);
		expect(requestUrlCalls).toHaveLength(2);
	});

	// Fewer vectors than inputs would shift every later chunk onto a neighbour's vector.
	it('refuses a response with the wrong number of vectors', async () => {
		__setRequestUrlHandler(() => ({json: {data: [{index: 0, embedding: [1]}]}}));
		const {provider} = makeProvider();

		await expect(provider.getEmbeddings(['a', 'b'])).rejects.toThrow('1 embeddings for 2 inputs');
		expect(requestUrlCalls).toHaveLength(1);
	});

	describe('classifying failures', () => {
		it('treats a 501 as embeddings unsupported, without retrying', async () => {
			__setRequestUrlHandler(() => ({status: 501, text: 'Not Implemented'}));
			const {provider} = makeProvider();

			await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
			expect(requestUrlCalls).toHaveLength(1);
		});

		// Backends phrase "this model cannot embed" differently and under different statuses;
		// the V1 raw-context fallback depends on catching all of them.
		it.each([
			[500, 'This server does not support embeddings. Start it with `--embeddings`'],
			[400, 'Pooling type \'none\' is not OAI compatible. Please use a different pooling type'],
			[400, 'Model "qwen" is not an embedding model'],
			[400, 'embeddings are not supported by this model'],
		])('treats a %s saying "%s" as embeddings unsupported', async (status, message) => {
			__setRequestUrlHandler(() => ({status, json: {error: {message}}}));
			const {provider} = makeProvider();

			await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
			expect(requestUrlCalls).toHaveLength(1);
		});

		it('treats a 404 as a missing model', async () => {
			__setRequestUrlHandler(() => ({status: 404, json: {error: {message: 'model not found'}}}));
			const {provider} = makeProvider();

			await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(ModelNotAvailableError);
		});

		it('retries any other server error', async () => {
			vi.useFakeTimers();
			__setRequestUrlHandler(() => ({status: 500, json: {error: {message: 'busy'}}}));
			const {provider} = makeProvider();

			const assertion = expect(provider.getEmbeddings(['a'])).rejects.toMatchObject({detail: 'busy'});
			await vi.advanceTimersByTimeAsync(2000);
			await assertion;

			expect(requestUrlCalls).toHaveLength(3);
		});

		it('classifies an error object returned with a 200', async () => {
			__setRequestUrlHandler(() => ({json: {error: {message: 'does not support embeddings'}}}));
			const {provider} = makeProvider();

			await expect(provider.getEmbeddings(['a'])).rejects.toBeInstanceOf(EmbeddingsUnsupportedError);
		});
	});
});

describe('getModelList', () => {
	it('lists the model ids from /v1/models, sorted', async () => {
		__setRequestUrlHandler(() => ({json: {object: 'list', data: [{id: 'zeta'}, {id: 'alpha'}]}}));
		const {provider} = makeProvider();

		expect(await provider.getModelList()).toEqual(['alpha', 'zeta']);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/v1/models`);
		expect(requestUrlCalls[0].method).toBe('GET');
	});

	it('returns an empty list when data is missing', async () => {
		__setRequestUrlHandler(() => ({json: {}}));
		const {provider} = makeProvider();

		expect(await provider.getModelList()).toEqual([]);
	});

	it('raises a failure with its status, after retrying', async () => {
		vi.useFakeTimers();
		__setRequestUrlHandler(() => ({status: 503, text: 'loading'}));
		const {provider} = makeProvider();

		const assertion = expect(provider.getModelList()).rejects.toMatchObject({status: 503});
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(requestUrlCalls).toHaveLength(3);
	});
});

describe('conversation', () => {
	it('shares the base history: follow-ups carry earlier turns', async () => {
		let n = 0;
		const spy = installFetch(async () => {
			n++;
			return streamResponse(sse([delta(`answer ${n}`), '[DONE]']));
		});
		const {provider} = makeProvider();

		await provider.sendQuestion('first');
		await provider.sendQuestion('second');

		expect(bodyOf(spy, 1).messages).toEqual([
			{role: 'user', content: 'first'},
			{role: 'assistant', content: 'answer 1'},
			{role: 'user', content: 'second'},
		]);
	});
});
