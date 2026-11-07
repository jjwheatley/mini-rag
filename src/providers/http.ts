import {requestUrl} from "obsidian";
import {ProviderUnreachableError} from "./errors";
import {streamTransport} from "./stream-transport";

export interface JsonRequest {
	url: string;
	body?: unknown;
	headers?: Record<string, string>;
}

/**
 * `json` is the parsed body, typed as the caller expects it to be. Nothing checks it against that
 * type: a server can send anything, so callers read it defensively.
 */
export interface JsonResult<T = unknown> {
	status: number;
	json: T;
	text: string;
}

/**
 * `throw: false` throughout, so the caller classifies a failure by status rather than by regexing
 * the message Obsidian would otherwise throw. That is what lets a 501 become a typed
 * EmbeddingsUnsupportedError instead of a `/status 501/` string match.
 */
async function sendJson<T>(method: 'GET' | 'POST', request: JsonRequest): Promise<JsonResult<T>> {
	try {
		const response = await requestUrl({
			method,
			url: request.url,
			throw: false,
			...(request.body !== undefined && {body: JSON.stringify(request.body)}),
			headers: {
				...(request.body !== undefined && {'Content-Type': 'application/json'}),
				...request.headers,
			},
		});
		const json: T = response.json;
		return {status: response.status, json, text: response.text};
	} catch (error) {
		// requestUrl still throws for transport-level failures, which no status can describe.
		const detail = error instanceof Error ? error.message : String(error);
		throw new ProviderUnreachableError(request.url, detail);
	}
}

export function getJson<T = unknown>(request: JsonRequest): Promise<JsonResult<T>> {
	return sendJson<T>('GET', request);
}

export function postJson<T = unknown>(request: JsonRequest): Promise<JsonResult<T>> {
	return sendJson<T>('POST', request);
}

/**
 * POSTs and feeds the response body to `onLine`, one line at a time.
 *
 * This goes through Node's http (stream-transport.ts) rather than Obsidian's requestUrl, because
 * requestUrl buffers the whole response and cannot stream or be cancelled.
 *
 * Owns the line buffering for every provider: partial lines carry across byte chunks, and a final
 * line with no trailing newline is still delivered.
 */
export async function streamLines(
	url: string,
	body: unknown,
	signal: AbortSignal,
	onLine: (line: string) => void,
	onHttpError: (status: number, bodyText: string) => Error,
	headers: Record<string, string> = {},
): Promise<void> {
	const response = await streamTransport.send(url, {
		method: "POST",
		headers: {"Content-Type": "application/json", ...headers},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw onHttpError(response.status, detail);
	}

	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, {stream: true});
		// Everything up to the last newline is whole lines; the rest carries to the next chunk.
		const end = buffer.lastIndexOf("\n");
		if (end === -1) continue;
		for (const line of buffer.slice(0, end).split("\n")) onLine(line);
		buffer = buffer.slice(end + 1);
	}

	// Flush data not followed by a newline. Ollama always terminates its lines; this is a guard
	// for backends that do not.
	if (buffer.trim()) onLine(buffer);
}

export type SseFrame = {payload: string} | 'done' | null;

/**
 * Decodes one line of an SSE stream: `data: {...}` yields the payload, `data: [DONE]` yields
 * 'done', and comments, blanks and non-data fields yield null.
 */
export function parseSseLine(line: string): SseFrame {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(':')) return null;
	if (!trimmed.startsWith('data:')) return null;

	const payload = trimmed.slice('data:'.length).trim();
	if (!payload) return null;
	if (payload === '[DONE]') return 'done';
	return {payload};
}

/** Pulls a human-readable message out of the various error shapes backends return. */
export function extractErrorText(json: unknown, text: string): string {
	if (typeof json === 'object' && json !== null) {
		const error = (json as {error?: unknown}).error;
		if (typeof error === 'string') return error;
		if (typeof error === 'object' && error !== null) {
			const message = (error as {message?: unknown}).message;
			if (typeof message === 'string') return message;
		}
	}
	return text;
}
