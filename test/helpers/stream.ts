/**
 * Helpers for driving the streaming code paths, which use raw `fetch` rather than `requestUrl`
 * (requestUrl buffers the whole response and cannot stream).
 *
 * The important capability here is emitting *arbitrary byte chunks* rather than whole lines, so
 * tests can split a JSON payload mid-token and prove the line buffer carries over correctly.
 */
import {vi} from 'vitest';

/** Builds a Response whose body emits exactly the chunks given, in order. */
export function streamResponse(chunks: string[], init: {status?: number; ok?: boolean} = {}): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	const status = init.status ?? 200;
	return {
		ok: init.ok ?? status < 400,
		status,
		body,
		text: async () => chunks.join(''),
	} as unknown as Response;
}

/** A Response with a null body — the case the empty-body guard exists for. */
export function nullBodyResponse(status = 200): Response {
	return {ok: status < 400, status, body: null, text: async () => ''} as unknown as Response;
}

/** An error Response: `ok` false, with a body of text for the error message to include. */
export function errorResponse(status: number, bodyText = ''): Response {
	return {ok: false, status, body: null, text: async () => bodyText} as unknown as Response;
}

/** Newline-terminates each object as one NDJSON line, then optionally re-splits into byte chunks. */
export function ndjson(lines: object[], split?: (whole: string) => string[]): string[] {
	const whole = lines.map(line => JSON.stringify(line) + '\n').join('');
	return split ? split(whole) : [whole];
}

/** Frames each object as an SSE `data:` event, then optionally re-splits into byte chunks. */
export function sse(payloads: (object | string)[], split?: (whole: string) => string[]): string[] {
	const whole = payloads
		.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
		.join('');
	return split ? split(whole) : [whole];
}

/** Splits a string into fixed-size pieces — the cheapest way to force mid-JSON boundaries. */
export const chunkEvery = (size: number) => (whole: string): string[] =>
	whole.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];

/** Replaces the global fetch for the current test; restored by `unstubGlobals`. */
export function installFetch(
	impl: (url: string, init: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
	const spy = vi.fn(impl);
	vi.stubGlobal('fetch', spy);
	return spy;
}

/** Installs a fetch that returns the given responses in order, one per call. */
export function installFetchSequence(responses: (() => Response)[]): ReturnType<typeof vi.fn> {
	let call = 0;
	return installFetch(async () => {
		const next = responses[Math.min(call, responses.length - 1)];
		call++;
		return next();
	});
}

/** The parsed JSON body of the nth recorded fetch call. */
export function fetchBody(spy: ReturnType<typeof vi.fn>, index = 0): any {
	const init = spy.mock.calls[index]?.[1] as RequestInit | undefined;
	return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
