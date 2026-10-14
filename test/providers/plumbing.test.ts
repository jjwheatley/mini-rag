import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetRequestUrl, __setRequestUrlHandler, requestUrlCalls} from '../stubs/obsidian';
import {
	EmbeddingDimensionMismatchError,
	EmbeddingsUnsupportedError,
	isAbortError,
	ModelNotAvailableError,
	ProviderError,
	ProviderUnreachableError,
} from '../../src/providers/errors';
import {extractErrorText, getJson, parseSseLine, postJson, streamLines} from '../../src/providers/http';
import {createProvider, listProviders} from '../../src/providers/factory';
import {OllamaProvider} from '../../src/providers/ollama-provider';
import {LlamaCppProvider} from '../../src/providers/llamacpp-provider';
import {defaultSettings} from '../../src/defaults';
import {ProviderId} from '../../src/types';
import {errorResponse, installFetch, nullBodyResponse, streamResponse} from '../helpers/stream';

beforeEach(() => {
	__resetRequestUrl();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('error types', () => {
	// Native `class` extends is only preserved above ES5. If the build target were ever lowered,
	// every instanceof check in the app would silently start returning false -- this catches that.
	it('preserves the prototype chain, so instanceof works', () => {
		const error = new EmbeddingsUnsupportedError('m', 'ollama');

		expect(error).toBeInstanceOf(EmbeddingsUnsupportedError);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toBeInstanceOf(Error);
	});

	it('marks an embeddings-unsupported error permanent, so it is not retried', () => {
		const error = new EmbeddingsUnsupportedError('llama3', 'ollama', 'no embed');

		expect(error.permanent).toBe(true);
		expect(error.status).toBe(501);
		expect(error.model).toBe('llama3');
		expect(error.providerId).toBe('ollama');
		expect(error.detail).toBe('no embed');
		expect(error.message).toContain('llama3');
	});

	it('marks a missing model permanent', () => {
		const error = new ModelNotAvailableError('nomic', 'not found');

		expect(error.permanent).toBe(true);
		expect(error.status).toBe(404);
		expect(error.model).toBe('nomic');
	});

	// Transient by design: the server may simply not be up yet.
	it('leaves an unreachable server retryable', () => {
		const error = new ProviderUnreachableError('http://localhost:11434', 'ECONNREFUSED');

		expect(error.permanent).toBe(false);
		expect(error.url).toBe('http://localhost:11434');
		expect(error.message).toContain('http://localhost:11434');
	});

	it('reports both sizes on a dimension mismatch', () => {
		const error = new EmbeddingDimensionMismatchError(768, 384);

		expect(error.expected).toBe(768);
		expect(error.received).toBe(384);
		expect(error.permanent).toBe(true);
		expect(error.message).toContain('768');
		expect(error.message).toContain('384');
	});

	it('defaults to retryable with no status', () => {
		const error = new ProviderError('something');

		expect(error.permanent).toBe(false);
		expect(error.status).toBeUndefined();
		expect(error.detail).toBeUndefined();
	});
});

describe('isAbortError', () => {
	it('recognises a DOMException AbortError', () => {
		expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
	});

	// The reason this exists: an in-process provider cancels by rejecting with a plain Error, and
	// the old `instanceof DOMException` check would have retried it.
	it('recognises a plain Error named AbortError', () => {
		const error = new Error('cancelled');
		error.name = 'AbortError';

		expect(isAbortError(error)).toBe(true);
	});

	it.each([
		new Error('boom'),
		new DOMException('other', 'NotFoundError'),
		'AbortError',
		null,
		undefined,
		{name: 'AbortError'},
	])('rejects %s', value => {
		expect(isAbortError(value)).toBe(false);
	});
});

describe('parseSseLine', () => {
	it('extracts a data payload', () => {
		expect(parseSseLine('data: {"a":1}')).toEqual({payload: '{"a":1}'});
	});

	it('accepts data with no space after the colon', () => {
		expect(parseSseLine('data:{"a":1}')).toEqual({payload: '{"a":1}'});
	});

	it('tolerates surrounding whitespace', () => {
		expect(parseSseLine('  data: {"a":1}  ')).toEqual({payload: '{"a":1}'});
	});

	it('recognises the [DONE] sentinel', () => {
		expect(parseSseLine('data: [DONE]')).toBe('done');
	});

	it.each([
		['', 'a blank line'],
		['   ', 'whitespace only'],
		[': keep-alive comment', 'a comment'],
		['event: message', 'a non-data field'],
		['id: 42', 'an id field'],
		['data:', 'an empty payload'],
		['{"a":1}', 'raw JSON with no data prefix'],
	])('returns null for %s (%s)', line => {
		expect(parseSseLine(line)).toBeNull();
	});
});

describe('extractErrorText', () => {
	it('reads a string error field (Ollama)', () => {
		expect(extractErrorText({error: 'model not found'}, 'raw')).toBe('model not found');
	});

	it('reads a nested error.message (OpenAI-compatible)', () => {
		expect(extractErrorText({error: {message: 'bad request', code: 400}}, 'raw')).toBe('bad request');
	});

	it.each([
		[null],
		[undefined],
		[{}],
		[{error: 42}],
		[{error: {}}],
		[{error: {message: 7}}],
	])('falls back to the raw text for %o', json => {
		expect(extractErrorText(json, 'raw body')).toBe('raw body');
	});
});

describe('getJson / postJson', () => {
	// throw:false is what lets the caller classify by status instead of regexing Obsidian's prose.
	it('returns a 4xx/5xx rather than throwing', async () => {
		__setRequestUrlHandler(() => ({status: 501, text: 'nope'}));

		const result = await getJson({url: 'http://x/api'});

		expect(result.status).toBe(501);
		expect(requestUrlCalls[0].throw).toBe(false);
	});

	it('sends a GET with no body', async () => {
		__setRequestUrlHandler(() => ({json: {ok: true}}));

		await getJson({url: 'http://x/api'});

		expect(requestUrlCalls[0].method).toBe('GET');
		expect(requestUrlCalls[0].body).toBeUndefined();
	});

	it('serialises a POST body as JSON and sets the content type', async () => {
		__setRequestUrlHandler(() => ({json: {ok: true}}));

		await postJson({url: 'http://x/api', body: {a: 1}});

		expect(requestUrlCalls[0].method).toBe('POST');
		expect(JSON.parse(String(requestUrlCalls[0].body))).toEqual({a: 1});
		expect(requestUrlCalls[0].headers?.['Content-Type']).toBe('application/json');
	});

	it('passes custom headers through', async () => {
		__setRequestUrlHandler(() => ({json: {}}));

		await postJson({url: 'http://x/api', body: {}, headers: {Authorization: 'Bearer t'}});

		expect(requestUrlCalls[0].headers?.Authorization).toBe('Bearer t');
	});

	// A transport failure has no status to classify, so it becomes a typed unreachable error.
	it('converts a thrown transport failure into ProviderUnreachableError', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('net::ERR_CONNECTION_REFUSED');
		});

		await expect(getJson({url: 'http://x/api'})).rejects.toBeInstanceOf(ProviderUnreachableError);
		await expect(getJson({url: 'http://x/api'})).rejects.toMatchObject({
			detail: 'net::ERR_CONNECTION_REFUSED',
		});
	});
});

describe('streamLines', () => {
	const collect = async (chunks: string[]): Promise<string[]> => {
		installFetch(async () => streamResponse(chunks));
		const lines: string[] = [];
		await streamLines('http://x', {}, new AbortController().signal, l => lines.push(l), () => new Error('http'));
		return lines;
	};

	it('splits complete lines', async () => {
		expect(await collect(['a\nb\n'])).toEqual(['a', 'b']);
	});

	it('carries a partial line across byte chunks', async () => {
		expect(await collect(['he', 'llo\nwor', 'ld\n'])).toEqual(['hello', 'world']);
	});

	it('flushes a trailing line with no newline', async () => {
		expect(await collect(['a\nb'])).toEqual(['a', 'b']);
	});

	it('does not flush trailing whitespace', async () => {
		expect(await collect(['a\n   '])).toEqual(['a']);
	});

	it('emits empty lines between content', async () => {
		expect(await collect(['a\n\nb\n'])).toEqual(['a', '', 'b']);
	});

	it('handles an empty body', async () => {
		expect(await collect([])).toEqual([]);
	});

	it('sends the body as JSON with the content type', async () => {
		const spy = installFetch(async () => streamResponse([]));

		await streamLines('http://x', {a: 1}, new AbortController().signal, () => {}, () => new Error('http'));

		const init = spy.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({a: 1});
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('merges extra headers', async () => {
		const spy = installFetch(async () => streamResponse([]));

		await streamLines(
			'http://x', {}, new AbortController().signal, () => {}, () => new Error('http'),
			{Authorization: 'Bearer t'},
		);

		expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({Authorization: 'Bearer t'});
	});

	it('delegates a non-ok response to onHttpError with the status and body', async () => {
		installFetch(async () => errorResponse(503, 'overloaded'));
		const onHttpError = vi.fn((status: number, body: string) => new Error(`${status}:${body}`));

		await expect(
			streamLines('http://x', {}, new AbortController().signal, () => {}, onHttpError),
		).rejects.toThrow('503:overloaded');
		expect(onHttpError).toHaveBeenCalledWith(503, 'overloaded');
	});

	it('raises a typed error for a null body', async () => {
		installFetch(async () => nullBodyResponse());

		await expect(
			streamLines('http://x', {}, new AbortController().signal, () => {}, () => new Error('http')),
		).rejects.toThrow('The server returned an empty response body.');
	});

	it('propagates an error thrown by the line handler', async () => {
		installFetch(async () => streamResponse(['a\nb\n']));

		await expect(
			streamLines('http://x', {}, new AbortController().signal, () => {
				throw new Error('bad line');
			}, () => new Error('http')),
		).rejects.toThrow('bad line');
	});
});

describe('createProvider', () => {
	const runtimeFor = (provider: string) => {
		const settings = defaultSettings();
		settings.provider = provider as ProviderId;
		return {settings};
	};

	it('builds an Ollama provider', () => {
		expect(createProvider(runtimeFor('ollama'))).toBeInstanceOf(OllamaProvider);
	});

	it('builds a llama.cpp provider', () => {
		expect(createProvider(runtimeFor('llamacpp'))).toBeInstanceOf(LlamaCppProvider);
	});

	// Names come from each provider's own capabilities, so the settings dropdown can never drift
	// from what the providers call themselves.
	it('lists every provider with its display name, for the settings dropdown', () => {
		expect(listProviders()).toEqual([
			{id: 'ollama', displayName: 'Ollama'},
			{id: 'llamacpp', displayName: 'llama.cpp'},
		]);
	});

	// A bad value in data.json must not stop the plugin loading.
	it.each(['openai', '', 'LLAMACPP'])('falls back to Ollama for the unknown id %s', id => {
		expect(createProvider(runtimeFor(id))).toBeInstanceOf(OllamaProvider);
	});

	it('is synchronous, since loadAI() is called synchronously from onload', () => {
		expect(createProvider(runtimeFor('ollama'))).not.toBeInstanceOf(Promise);
	});

	it('returns a fresh instance each call, which is how a new chat resets context', () => {
		const runtime = runtimeFor('ollama');

		expect(createProvider(runtime)).not.toBe(createProvider(runtime));
	});
});
