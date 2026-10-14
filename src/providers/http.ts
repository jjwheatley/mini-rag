import {requestUrl} from "obsidian";
import {ProviderError, ProviderUnreachableError} from "./errors";

export interface JsonRequest {
	url: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export interface JsonResult {
	status: number;
	json: any;
	text: string;
}

/**
 * `throw: false` throughout, so the caller classifies a failure by status rather than by regexing
 * the message Obsidian would otherwise throw. That is what lets a 501 become a typed
 * EmbeddingsUnsupportedError instead of a `/status 501/` string match.
 */
async function sendJson(method: 'GET' | 'POST', request: JsonRequest): Promise<JsonResult> {
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
		return {status: response.status, json: response.json, text: response.text};
	} catch (error) {
		// requestUrl still throws for transport-level failures, which no status can describe.
		const detail = error instanceof Error ? error.message : String(error);
		throw new ProviderUnreachableError(request.url, detail);
	}
}

export function getJson(request: JsonRequest): Promise<JsonResult> {
	return sendJson('GET', request);
}

export function postJson(request: JsonRequest): Promise<JsonResult> {
	return sendJson('POST', request);
}

/**
 * POSTs and feeds the response body to `onLine`, one line at a time.
 *
 * This uses fetch rather than Obsidian's requestUrl because requestUrl buffers the whole response
 * and cannot stream. That is safe here: the plugin is desktop-only and talks to a local server, so
 * there is no CORS concern. (A non-localhost URL would hit CORS on this path but not on the
 * requestUrl ones, which presents as "the model list loads but chat fails".)
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
	const response = await fetch(url, {
		method: "POST",
		headers: {"Content-Type": "application/json", ...headers},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw onHttpError(response.status, detail);
	}

	if (!response.body) {
		throw new ProviderError("The server returned an empty response body.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	let readResult = await reader.read();
	while (!readResult.done) {
		buffer += decoder.decode(readResult.value, {stream: true});
		const lines = buffer.split("\n");
		// The last element is either an incomplete line or "", so it carries to the next chunk.
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
		readResult = await reader.read();
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
