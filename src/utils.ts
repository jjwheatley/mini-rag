import {Message} from "./types";

const padToTwo = (num: number) => {
	return num.toString().padStart(2, '0');
}

export const getTimestampFromDate = (date: Date): string => {
	return (
		[
			date.getFullYear(),
			padToTwo(date.getMonth() + 1),
			padToTwo(date.getDate()),
		].join('-') +
		' ' +
		[
			padToTwo(date.getHours()),
			padToTwo(date.getMinutes()),
			padToTwo(date.getSeconds()),
		].join(':')
	);
}

export const firstToUpper = (str: string) => `${str.charAt(0).toUpperCase()}${str.slice(1)}`

// Characters that are illegal in file names across Windows/macOS/Linux,
// plus the ASCII control characters (U+0000–U+001F).
const ILLEGAL_FILENAME_CHARS = new Set<string>([
	'<', '>', ':', '"', '/', '\\', '|', '?', '*',
	//Add the 32 unreadable characters from '\x00' to '\x1f'
	...Array.from({length: 32}, (_, code) => String.fromCharCode(code)),
]);

function replaceIllegalChars(value: string): string {
	let result = '';
	for (const char of value) {
		result += ILLEGAL_FILENAME_CHARS.has(char) ? '-' : char;
	}
	return result;
}

/** Removes characters invalid in Windows/macOS/Linux file names. */
export function sanitizeFilename(name: string, maxLength = 120): string {
	const sanitized = replaceIllegalChars(name)
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\.+$/g, '')
		.slice(0, maxLength);
	return sanitized.length > 0 ? sanitized : 'untitled';
}

function escapeYaml(value: string): string {
	if (/[:#\n\r\t'"\\{}[\]>|]/.test(value) || /^[-?@`!&*]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
	}
	return value;
}

export interface ChatExportMeta {
	model: string;
	modelDisplay: string;
	started: Date;
	updated: Date;
	contextSubject?: string;
}

export function formatChatAsMarkdown(messages: Message[], meta: ChatExportMeta): string {
	const lines: string[] = [
		'---',
		'type: mini-rag-chat',
		`model: ${escapeYaml(meta.model)}`,
		`started: ${meta.started.toISOString()}`,
		`updated: ${meta.updated.toISOString()}`,
	];

	if (meta.contextSubject) {
		lines.push(`context: ${escapeYaml(meta.contextSubject)}`);
	}

	lines.push(
		'---',
		'',
		`# Mini-RAG Chat with ${meta.modelDisplay}`,
		'',
		meta.contextSubject
			? `> **Context:** ${meta.contextSubject}`
			: '> **Context:** Context-free',
		'',
	);

	for (const message of messages) {
		const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
		lines.push(`## ${roleLabel} · ${message.timestamp}`, '', message.content, '');
	}

	return lines.join('\n').trimEnd() + "\n";
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	retries = 2,
	delayMs = 1000,
	shouldAbort?: () => boolean,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			// A user-initiated cancel (e.g. closing the panel mid-stream) must not be
			// retried — retrying would start a fresh request and defeat the abort.
			if (error instanceof DOMException && error.name === 'AbortError') {
				throw error;
			}
			lastError = error;
			if (attempt < retries) {
				// Check for an abort that arrived while the previous attempt was running.
				if (shouldAbort?.()) throw lastError;
				await new Promise(resolve => setTimeout(resolve, delayMs));
				// Check again after the sleep — abort() may have been called during the delay.
				if (shouldAbort?.()) throw lastError;
			}
		}
	}
	throw lastError;
}

export function buildChatSaveFilename(
	fileDate: Date,
	modelDisplay: string,
	includeMilliseconds = false
): string {
	const stamp = getTimestampFromDate(fileDate).replace(/:/g, '-');
	const msSuffix = includeMilliseconds
		? `-${String(fileDate.getMilliseconds()).padStart(3, '0')}`
		: '';
	const stem = sanitizeFilename(`${stamp}${msSuffix} - Chat with ${modelDisplay}`);
	return `${stem}.md`;
}

/** Sanitizes user input and ensures a .md extension. Returns null if empty. */
export function normalizeChatFilename(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}

	let name = sanitizeFilename(trimmed);
	if (!name.toLowerCase().endsWith('.md')) {
		name = `${name}.md`;
	}

	return name.length > 0 ? name : null;
}

function extractOllamaErrorDetail(message: string): string {
	const jsonMatch = message.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as {error?: string};
			if (parsed.error) {
				return parsed.error;
			}
		} catch {
			// Not JSON — use the raw message below.
		}
	}

	return message.replace(/^Ollama request failed \(\d+\):\s*/i, "").trim() || message;
}

/** Turns raw Ollama HTTP / runner errors into clearer guidance for the chat UI. */
export function formatOllamaError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const detail = extractOllamaErrorDetail(message);

	if (/cuda|gpu|vulkan|shared object initialization/i.test(detail)) {
		return [
			"Ollama could not run the model on your GPU (CUDA error).",
			"",
			"This comes from Ollama on your machine, not from Mini-RAG. Try:",
			"• Quit and restart the Ollama app",
			"• Update your GPU drivers",
			"• Force CPU mode: set OLLAMA_NO_GPU=1, then restart Ollama",
			"• Choose a smaller model in Mini-RAG settings",
			"",
			`Details: ${detail}`,
		].join("\n");
	}

	if (detail !== message) {
		return detail;
	}

	return message;
}
