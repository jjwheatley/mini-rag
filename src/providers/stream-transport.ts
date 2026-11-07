import {ClientRequest, IncomingMessage, request as httpRequest, RequestOptions} from "http";
import {request as httpsRequest} from "https";
import {isAbortError, ProviderUnreachableError} from "./errors";

export interface StreamRequest {
	method: 'POST';
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
}

/** What streamLines needs of a response. Read either `body` or `text()`, not both. */
export interface StreamResponse {
	status: number;
	ok: boolean;
	/** The body, chunk by chunk, as the server sends it. */
	body: AsyncIterable<Uint8Array>;
	text(): Promise<string>;
}

const cancelled = () => new DOMException('The request was cancelled.', 'AbortError');

/**
 * Sends a request through Node's http or https, and resolves once the response starts, leaving the
 * body to be read as it arrives.
 *
 * Obsidian's requestUrl buffers the whole response and cannot be cancelled, so a reply could only
 * appear once complete, and Stop could not interrupt it. Node is always there, since Mini-RAG is
 * desktop-only. Like requestUrl, and unlike fetch, its requests are not subject to CORS, so a
 * server that answers the model list also answers the chat.
 *
 * Cancelling rejects with an AbortError, before the response or while its body is read, which is
 * how callers tell a cancel from a failure.
 */
export function sendStreamRequest(url: string, {method, headers, body, signal}: StreamRequest): Promise<StreamResponse> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(cancelled());
			return;
		}
		const target = new URL(url);
		const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
		const options: RequestOptions & {autoSelectFamily: boolean} = {
			method,
			headers: {...headers, 'Content-Length': String(Buffer.byteLength(body))},
			// "localhost" can resolve to ::1 first while the server listens on 127.0.0.1 only. Like a
			// browser, try both.
			autoSelectFamily: true,
		};

		let destroyable: ClientRequest | IncomingMessage;
		const request = send(target, options, response => {
			destroyable = response;
			// An error is surfaced by whoever reads the body; without a listener it would be uncaught.
			response.on('error', () => {});
			const status = response.statusCode ?? 0;
			resolve({status, ok: status >= 200 && status < 300, body: response, text: () => readText(response)});
		});
		destroyable = request;
		signal.addEventListener('abort', () => destroyable.destroy(cancelled()), {once: true});
		request.on('error', error => {
			reject(isAbortError(error) ? error : new ProviderUnreachableError(url, error.message));
		});
		request.end(body);
	});
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let text = '';
	for await (const chunk of body) text += decoder.decode(chunk, {stream: true});
	return text + decoder.decode();
}

/** What streamLines sends through. Tests swap `send` for a fake server. */
export const streamTransport = {send: sendStreamRequest};
