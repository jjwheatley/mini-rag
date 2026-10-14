import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	buildChatSaveFilename,
	ChatExportMeta,
	firstToUpper,
	formatChatAsMarkdown,
	getTimestampFromDate,
	normalizeChatFilename,
	sanitizeFilename,
	withRetry,
} from '../src/utils';
import {Message} from '../src/types';

describe('getTimestampFromDate', () => {
	// Built from local-time components, so the fixtures use the local-time Date constructor.
	it('formats as YYYY-MM-DD HH:mm:ss', () => {
		expect(getTimestampFromDate(new Date(2026, 8, 10, 14, 30, 45))).toBe('2026-09-10 14:30:45');
	});

	it('zero-pads every component', () => {
		expect(getTimestampFromDate(new Date(2026, 0, 5, 9, 8, 7))).toBe('2026-01-05 09:08:07');
	});

	it('maps January to 01 rather than 00', () => {
		expect(getTimestampFromDate(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00:00');
	});

	it('maps December to 12', () => {
		expect(getTimestampFromDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59');
	});
});

describe('firstToUpper', () => {
	it('uppercases the first character', () => {
		expect(firstToUpper('llama')).toBe('Llama');
	});

	it('leaves an already-uppercase string alone', () => {
		expect(firstToUpper('Llama')).toBe('Llama');
	});

	it('handles a single character', () => {
		expect(firstToUpper('a')).toBe('A');
	});

	it('handles an empty string', () => {
		expect(firstToUpper('')).toBe('');
	});

	it('leaves a leading digit alone', () => {
		expect(firstToUpper('3b-model')).toBe('3b-model');
	});
});

describe('sanitizeFilename', () => {
	it('leaves a clean name untouched', () => {
		expect(sanitizeFilename('Chat with Llama')).toBe('Chat with Llama');
	});

	it.each(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])(
		'replaces the illegal character %s with a dash',
		char => {
			expect(sanitizeFilename(`a${char}b`)).toBe('a-b');
		},
	);

	it.each([0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f])(
		'replaces the control character 0x%s with a dash',
		code => {
			expect(sanitizeFilename(`a${String.fromCharCode(code)}b`)).toBe('a-b');
		},
	);

	it('collapses runs of spaces into a single space', () => {
		expect(sanitizeFilename('a    b')).toBe('a b');
	});

	// Order of operations: illegal characters are replaced BEFORE whitespace is collapsed, and
	// tabs/newlines are in the control-character set. So they become dashes and are never
	// collapsed as whitespace -- 'a\tb' is 'a-b', not 'a b'.
	it('turns tabs into dashes rather than collapsing them as whitespace', () => {
		expect(sanitizeFilename('a\t\tb')).toBe('a--b');
		expect(sanitizeFilename('a \t b')).toBe('a - b');
	});

	it('trims surrounding whitespace', () => {
		expect(sanitizeFilename('   padded   ')).toBe('padded');
	});

	it('strips trailing dots', () => {
		expect(sanitizeFilename('name...')).toBe('name');
	});

	it('keeps interior dots', () => {
		expect(sanitizeFilename('llama3.1 chat')).toBe('llama3.1 chat');
	});

	it('truncates to maxLength', () => {
		expect(sanitizeFilename('x'.repeat(200))).toHaveLength(120);
	});

	it('honours an explicit maxLength', () => {
		expect(sanitizeFilename('abcdefghij', 4)).toBe('abcd');
	});

	it('falls back to untitled for an empty result', () => {
		expect(sanitizeFilename('')).toBe('untitled');
		expect(sanitizeFilename('   ')).toBe('untitled');
		expect(sanitizeFilename('...')).toBe('untitled');
	});

	// Truncation happens before the trailing-dot strip is applied to the *original* string, so a
	// cut can still leave a trailing dot. Pinned because it affects real saved-chat filenames.
	it('can leave a trailing dot when truncation cuts mid-name', () => {
		expect(sanitizeFilename('abc.def', 4)).toBe('abc.');
	});
});

describe('formatChatAsMarkdown', () => {
	const message = (role: Message['role'], content: string, timestamp: string): Message => ({
		role,
		content,
		timestamp,
	});

	const meta = (overrides: Partial<ChatExportMeta> = {}): ChatExportMeta => ({
		model: 'llama3',
		modelDisplay: 'Llama3',
		started: new Date('2026-09-10T10:00:00.000Z'),
		updated: new Date('2026-09-10T10:05:00.000Z'),
		...overrides,
	});

	it('renders front matter, heading and messages (context-free)', () => {
		const output = formatChatAsMarkdown(
			[
				message('user', 'What is RAG?', '2026-09-10 11:00:00'),
				message('assistant', 'Retrieval Augmented Generation.', '2026-09-10 11:00:05'),
			],
			meta(),
		);

		expect(output).toBe(
			[
				'---',
				'type: mini-rag-chat',
				'model: llama3',
				'started: 2026-09-10T10:00:00.000Z',
				'updated: 2026-09-10T10:05:00.000Z',
				'---',
				'',
				'# Mini-RAG Chat with Llama3',
				'',
				'> **Context:** Context-free',
				'',
				'## User · 2026-09-10 11:00:00',
				'',
				'What is RAG?',
				'',
				'## Assistant · 2026-09-10 11:00:05',
				'',
				'Retrieval Augmented Generation.',
				'',
			].join('\n'),
		);
	});

	it('adds a context key and blockquote when a subject is given', () => {
		const output = formatChatAsMarkdown([], meta({contextSubject: 'Projects'}));

		expect(output).toContain('context: Projects');
		expect(output).toContain('> **Context:** Projects');
		expect(output).not.toContain('Context-free');
	});

	it('ends with exactly one trailing newline', () => {
		const output = formatChatAsMarkdown(
			[message('user', 'hi', '2026-09-10 11:00:00')],
			meta(),
		);
		expect(output.endsWith('\n')).toBe(true);
		expect(output.endsWith('\n\n')).toBe(false);
	});

	it('renders with no messages at all', () => {
		const output = formatChatAsMarkdown([], meta());
		expect(output).toContain('# Mini-RAG Chat with Llama3');
		expect(output).not.toContain('## User');
	});

	// A model name with a colon is the common case for Ollama, and the colon is what forces the
	// YAML quoting branch. This golden value changes if a `provider:` key is ever added.
	it('quotes a model name containing a colon', () => {
		const output = formatChatAsMarkdown([], meta({model: 'llama3.1:8b'}));
		expect(output).toContain('model: "llama3.1:8b"');
	});

	it('escapes a context subject containing a quote', () => {
		const output = formatChatAsMarkdown([], meta({contextSubject: 'My "notes"'}));
		expect(output).toContain('context: "My \\"notes\\""');
	});

	it('escapes a context subject containing a backslash', () => {
		const output = formatChatAsMarkdown([], meta({contextSubject: 'a\\b'}));
		expect(output).toContain('context: "a\\\\b"');
	});

	it('quotes a context subject starting with a dash', () => {
		const output = formatChatAsMarkdown([], meta({contextSubject: '-leading'}));
		expect(output).toContain('context: "-leading"');
	});

	it('quotes a context subject with a trailing space', () => {
		const output = formatChatAsMarkdown([], meta({contextSubject: 'trailing '}));
		expect(output).toContain('context: "trailing "');
	});

	it('leaves message content unescaped', () => {
		const output = formatChatAsMarkdown(
			[message('assistant', 'Use `a: b` in YAML', '2026-09-10 11:00:00')],
			meta(),
		);
		expect(output).toContain('Use `a: b` in YAML');
	});
});

describe('buildChatSaveFilename', () => {
	it('replaces the time colons with dashes and appends .md', () => {
		expect(buildChatSaveFilename(new Date(2026, 8, 10, 14, 30, 45), 'Llama3')).toBe(
			'2026-09-10 14-30-45 - Chat with Llama3.md',
		);
	});

	it('appends zero-padded milliseconds when asked', () => {
		const date = new Date(2026, 8, 10, 14, 30, 45);
		date.setMilliseconds(7);
		expect(buildChatSaveFilename(date, 'Llama3', true)).toBe(
			'2026-09-10 14-30-45-007 - Chat with Llama3.md',
		);
	});

	it('sanitizes a model display name containing illegal characters', () => {
		expect(buildChatSaveFilename(new Date(2026, 8, 10, 14, 30, 45), 'nomic-ai/model')).toBe(
			'2026-09-10 14-30-45 - Chat with nomic-ai-model.md',
		);
	});
});

describe('normalizeChatFilename', () => {
	it('appends .md when missing', () => {
		expect(normalizeChatFilename('My chat')).toBe('My chat.md');
	});

	it('leaves an existing .md extension alone', () => {
		expect(normalizeChatFilename('My chat.md')).toBe('My chat.md');
	});

	it('treats an uppercase extension as already present', () => {
		expect(normalizeChatFilename('My chat.MD')).toBe('My chat.MD');
	});

	it('trims and sanitizes', () => {
		expect(normalizeChatFilename('  a/b  ')).toBe('a-b.md');
	});

	it('returns null for empty or whitespace-only input', () => {
		expect(normalizeChatFilename('')).toBeNull();
		expect(normalizeChatFilename('   ')).toBeNull();
	});

	it('falls back to untitled.md when sanitizing removes everything', () => {
		expect(normalizeChatFilename('...')).toBe('untitled.md');
	});
});

describe('withRetry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls fn once on success and never sleeps', async () => {
		const fn = vi.fn(async () => 'ok');
		await expect(withRetry(fn)).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries twice then succeeds, sleeping exactly 1000ms between attempts', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('first'))
			.mockRejectedValueOnce(new Error('second'))
			.mockResolvedValueOnce('ok');

		const promise = withRetry(fn);

		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(1);

		// One millisecond short of the delay: still no second attempt.
		await vi.advanceTimersByTimeAsync(999);
		expect(fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(fn).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(1000);
		await expect(promise).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('honours a custom delay', async () => {
		vi.useFakeTimers();
		const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

		const promise = withRetry(fn, 2, 50);
		await vi.advanceTimersByTimeAsync(49);
		expect(fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(promise).resolves.toBe('ok');
	});

	it('makes retries + 1 attempts and rejects with the LAST error', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('first'))
			.mockRejectedValueOnce(new Error('second'))
			.mockRejectedValueOnce(new Error('third'));

		const promise = withRetry(fn);
		const assertion = expect(promise).rejects.toThrow('third');

		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('makes exactly one attempt when retries is 0', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('boom'));
		await expect(withRetry(fn, 0)).rejects.toThrow('boom');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('rethrows an AbortError immediately without retrying', async () => {
		const fn = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));

		await expect(withRetry(fn)).rejects.toThrow('cancelled');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	// Pins today's behaviour: the check is `instanceof DOMException`, so a plain Error merely
	// *named* AbortError is retried. This is what isAbortError() is due to generalise.
	it('retries a plain Error named AbortError (not a DOMException)', async () => {
		vi.useFakeTimers();
		const abortish = new Error('cancelled');
		abortish.name = 'AbortError';
		const fn = vi.fn().mockRejectedValue(abortish);

		const promise = withRetry(fn);
		const assertion = expect(promise).rejects.toThrow('cancelled');
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('skips the retry when shouldAbort is already true before the sleep', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('boom'));

		await expect(withRetry(fn, 2, 1000, () => true)).rejects.toThrow('boom');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	// The subtlest branch: abort() lands while the retry delay is still running.
	it('skips the retry when shouldAbort flips to true during the sleep', async () => {
		vi.useFakeTimers();
		let aborted = false;
		const fn = vi.fn().mockRejectedValue(new Error('boom'));

		const promise = withRetry(fn, 2, 1000, () => aborted);
		const assertion = expect(promise).rejects.toThrow('boom');

		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(1);

		aborted = true;
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does not consult shouldAbort on a successful call', async () => {
		const shouldAbort = vi.fn(() => true);
		await expect(withRetry(async () => 'ok', 2, 1000, shouldAbort)).resolves.toBe('ok');
		expect(shouldAbort).not.toHaveBeenCalled();
	});

	it('does not consult shouldAbort after the final attempt', async () => {
		const shouldAbort = vi.fn(() => false);
		const fn = vi.fn().mockRejectedValue(new Error('boom'));

		await expect(withRetry(fn, 0, 1000, shouldAbort)).rejects.toThrow('boom');
		expect(shouldAbort).not.toHaveBeenCalled();
	});

	it('propagates a non-Error rejection', async () => {
		const fn = vi.fn().mockRejectedValue('a string');
		await expect(withRetry(fn, 0)).rejects.toBe('a string');
	});
});
