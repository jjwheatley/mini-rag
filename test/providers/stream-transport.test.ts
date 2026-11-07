import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createServer, IncomingMessage, Server, ServerResponse} from 'http';
import {AddressInfo} from 'net';
import {sendStreamRequest} from '../../src/providers/stream-transport';
import {isAbortError, ProviderUnreachableError} from '../../src/providers/errors';

// The transport is plumbing over Node's http, so it is tested against a real server on a free
// local port rather than against a fake of what Node might do.
let server: Server;
let base: string;
let respond: (req: IncomingMessage, res: ServerResponse) => void;
let received: {method?: string; url?: string; headers: IncomingMessage['headers']; body: string}[];

beforeEach(async () => {
	received = [];
	respond = (_req, res) => res.end();
	server = createServer((req, res) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', () => {
			received.push({method: req.method, url: req.url, headers: req.headers, body});
			respond(req, res);
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	if (!server.listening) return;
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
});

const post = (url: string, signal = new AbortController().signal, body = '{"q":"café"}') =>
	sendStreamRequest(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body, signal});

const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk);

async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
	let text = '';
	for await (const chunk of body) text += decode(chunk);
	return text;
}

describe('sendStreamRequest', () => {
	it('sends the method, path, headers and body', async () => {
		const response = await post(`${base}/api/chat`);
		await readAll(response.body);

		expect(received[0]).toMatchObject({method: 'POST', url: '/api/chat', body: '{"q":"café"}'});
		expect(received[0].headers['content-type']).toBe('application/json');
		// In bytes, not characters: "é" is two.
		expect(received[0].headers['content-length']).toBe('13');
	});

	// The reason for the transport: requestUrl hands over a reply only once it is complete.
	it('delivers the body as the server writes it', async () => {
		let finish = () => {};
		respond = (_req, res) => {
			res.write('first\n');
			finish = () => res.end('second\n');
		};
		const response = await post(base);
		const chunks = response.body[Symbol.asyncIterator]();

		expect(decode((await chunks.next()).value)).toBe('first\n');
		finish();
		expect(decode((await chunks.next()).value)).toBe('second\n');
		expect((await chunks.next()).done).toBe(true);
	});

	it('is ok with a 2xx status', async () => {
		const response = await post(base);

		expect(response).toMatchObject({status: 200, ok: true});
	});

	it('gives an error status, and its body as text', async () => {
		respond = (_req, res) => {
			res.statusCode = 503;
			res.end('overloaded');
		};
		const response = await post(base);

		expect(response).toMatchObject({status: 503, ok: false});
		expect(await response.text()).toBe('overloaded');
	});

	it('sends nothing once already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();

		const error = await post(base, controller.signal).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DOMException);
		expect(isAbortError(error)).toBe(true);
		expect(received).toHaveLength(0);
	});

	it('cancels while waiting for the server to answer', async () => {
		respond = () => {};
		const controller = new AbortController();
		const pending = post(base, controller.signal).catch((e: unknown) => e);
		await vi.waitFor(() => expect(received).toHaveLength(1));

		controller.abort();

		expect(isAbortError(await pending)).toBe(true);
	});

	// What Stop in the chat panel relies on: the reply stops arriving, as an AbortError.
	it('cancels a reply mid-stream', async () => {
		respond = (_req, res) => res.write('first\n');
		const controller = new AbortController();
		const response = await post(base, controller.signal);
		const chunks = response.body[Symbol.asyncIterator]();
		await chunks.next();

		controller.abort();

		expect(isAbortError(await chunks.next().catch((e: unknown) => e))).toBe(true);
	});

	it('reports a server that is not listening as unreachable', async () => {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));

		const error = await post(`${base}/api/chat`).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ProviderUnreachableError);
		expect((error as ProviderUnreachableError).url).toBe(`${base}/api/chat`);
	});

	// Proved by its failure: a plain-HTTP server cannot complete the TLS handshake https starts.
	it('speaks TLS to an https URL', async () => {
		const error = await post(base.replace('http:', 'https:')).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ProviderUnreachableError);
		expect(received).toHaveLength(0);
	});
});
