/**
 * Helpers for driving the streaming code paths, which send through Node's http (see
 * stream-transport.ts) rather than `requestUrl`, since requestUrl buffers the whole response and
 * cannot stream. The transport itself is tested against a real server; these fake it, so provider
 * tests can script exactly what a server sends.
 *
 * The important capability here is emitting *arbitrary byte chunks* rather than whole lines, so
 * tests can split a JSON payload mid-token and prove the line buffer carries over correctly.
 */
import {vi} from 'vitest';
import {StreamRequest, StreamResponse, streamTransport} from '../../src/providers/stream-transport';

/** A response whose body yields exactly the chunks given, in order. */
export function streamResponse(chunks: string[], init: {status?: number} = {}): StreamResponse {
	const encoder = new TextEncoder();
	const status = init.status ?? 200;
	return {
		status,
		ok: status >= 200 && status < 300,
		body: (async function* () {
			for (const chunk of chunks) yield encoder.encode(chunk);
		})(),
		text: async () => chunks.join(''),
	};
}

/** An error response, with a body of text for the error message to include. */
export function errorResponse(status: number, bodyText = ''): StreamResponse {
	return {...streamResponse([bodyText], {status}), ok: false};
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

/** Replaces the transport's `send` for the current test; restored by `restoreMocks`. */
export function installTransport(
	impl: (url: string, init: StreamRequest) => Promise<StreamResponse>,
): ReturnType<typeof vi.fn> {
	return vi.spyOn(streamTransport, 'send').mockImplementation(impl) as unknown as ReturnType<typeof vi.fn>;
}

/** Installs a transport that returns the given responses in order, one per call. */
export function installTransportSequence(responses: (() => StreamResponse)[]): ReturnType<typeof vi.fn> {
	let call = 0;
	return installTransport(async () => {
		const next = responses[Math.min(call, responses.length - 1)];
		call++;
		return next();
	});
}

/** The parsed JSON body of the nth request sent. */
export function requestBody(spy: ReturnType<typeof vi.fn>, index = 0): any {
	const init = spy.mock.calls[index]?.[1] as StreamRequest | undefined;
	return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
