import {describe, expect, it, vi} from 'vitest';
import {
	MAX_COMBINE_LEVELS,
	COMBINE_SUMMARY_TOKENS,
	PART_SUMMARY_TOKENS,
	planParts,
	splitText,
	summarizeNotes,
	takePart,
} from '../src/summarize';
import {fitNotes} from '../src/context-budget';
import {composeCombinePrompt, composePartSummaryPrompt, composeSummarizePrompt} from '../src/prompt';

const note = (name: string, length: number, fill = 'x') => ({name, text: fill.repeat(length)});
const words = (name: string, count: number) => ({name, text: 'word '.repeat(count).trim()});
const partText = (part: {name: string; text: string}[]) => fitNotes(part, null).text;
const nonSpace = (text: string) => text.replace(/\s/g, '');
const names = (parts: {name: string}[][]) => parts.map(part => part.map(n => n.name));

describe('splitText', () => {
	it('returns text that fits as it is', () => {
		expect(splitText('short', 10)).toEqual(['short']);
	});

	// A paragraph break is the most natural place to cut, so it is preferred to a space.
	it('breaks at the last blank line before the limit', () => {
		expect(splitText('aaa bb\n\ncccc dd', 12)).toEqual(['aaa bb', 'cccc dd']);
	});

	it('falls back to the last space', () => {
		expect(splitText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc']);
	});

	it('cuts hard when there is nowhere to break', () => {
		expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
	});

	// Unlike the chunker's splitter, which embeds text and may drop scraps, nothing is lost here:
	// a summary should cover every word.
	it('keeps every word, and never exceeds the limit', () => {
		const text = Array.from({length: 400}, (_, i) => (i % 7 === 0 ? 'para\n\nword' : `word${i}`)).join(' ');

		const pieces = splitText(text, 97);

		expect(pieces.every(piece => piece.length <= 97)).toBe(true);
		expect(nonSpace(pieces.join(''))).toBe(nonSpace(text));
	});

	// Leading whitespace would otherwise make the first piece an empty one.
	it('drops leading whitespace', () => {
		expect(splitText('  aaaa bbbb', 5)).toEqual(['aaaa', 'bbbb']);
	});

	it('terminates on a limit below one', () => {
		expect(splitText('abc', 0)).toEqual(['a', 'b', 'c']);
	});
});

describe('takePart', () => {
	it('takes whole notes, in order, while they fit', () => {
		// "[a.md]\n" + 40 = 47 characters a note, 7 more for each separator: two fit in 101.
		const {part, rest} = takePart([note('a.md', 40), note('b.md', 40), note('c.md', 40)], 101);

		expect(part.map(n => n.name)).toEqual(['a.md', 'b.md']);
		expect(rest.map(n => n.name)).toEqual(['c.md']);
	});

	// Starting a new part whenever the next note does not fit wastes the rest of the window.
	it('fills the rest of the part with the start of the next note', () => {
		const {part, rest} = takePart([words('a.md', 60), words('b.md', 60)], 400);

		expect(part.map(n => n.name)).toEqual(['a.md', 'b.md (part 1)']);
		expect(partText(part).length).toBeGreaterThan(360);
		expect(rest).toHaveLength(1);
	});

	// Notes often end in blank lines; dropping them can make a note fit after all.
	it('keeps a note whole when only its trailing blank lines overflowed', () => {
		const padded = {name: 'b.md', text: `${'word '.repeat(5).trim()}${'\n'.repeat(80)}`};

		const {part, rest} = takePart([words('a.md', 60), padded], 400);

		expect(part.map(n => n.name)).toEqual(['a.md', 'b.md']);
		expect(part[1].text).toBe('word word word word word');
		expect(rest).toEqual([]);
	});

	it('starts a new part rather than end this one with a scrap', () => {
		// a.md fills 357 of 400; the 36 left are under a fifth of the part.
		const {part, rest} = takePart([words('a.md', 70), words('b.md', 60)], 400);

		expect(part.map(n => n.name)).toEqual(['a.md']);
		expect(rest).toEqual([words('b.md', 60)]);
	});
});

describe('planParts', () => {
	it('numbers the pieces of a note that runs across parts', () => {
		expect(names(planParts([words('a.md', 60), words('b.md', 60)], 400))).toEqual([
			['a.md', 'b.md (part 1)'],
			['b.md (part 2)'],
		]);
	});

	it('cuts a note too large for any part into numbered pieces', () => {
		expect(names(planParts([words('big.md', 50)], 120))).toEqual([
			['big.md (part 1)'],
			['big.md (part 2)'],
			['big.md (part 3)'],
		]);
	});

	const mixed = () => Array.from({length: 40}, (_, i) => words(`n${i}.md`, [12, 300, 45, 900, 5, 160][i % 6]));

	it('keeps every part within the budget', () => {
		for (const part of planParts(mixed(), 2000)) {
			expect(partText(part).length).toBeLessThanOrEqual(2000);
		}
	});

	it('leaves no part but the last much short of full', () => {
		const parts = planParts(mixed(), 2000);

		for (const part of parts.slice(0, -1)) {
			expect(partText(part).length).toBeGreaterThanOrEqual(0.75 * 2000);
		}
	});

	it('loses nothing, and keeps the order', () => {
		const notes = mixed();

		const planned = planParts(notes, 2000).flat().map(n => n.text).join(' ');

		expect(nonSpace(planned)).toBe(nonSpace(notes.map(n => n.text).join(' ')));
	});

	it('plans nothing for no notes', () => {
		expect(planParts([], 100)).toEqual([]);
	});
});

describe('summarizeNotes', () => {
	interface FakeOptions {
		/** How long each answer is. */
		summaryLength?: number;
		/** The model's characters per token; null for a server that reports no token count. */
		charsPerToken?: number | null;
	}

	/**
	 * A model that answers each prompt with a fixed-length summary and reports the prompt's token
	 * count as a tokenizer of the given density would, plus a little for the chat template.
	 */
	function fakeModel({summaryLength = 20, charsPerToken = 4.65}: FakeOptions = {}) {
		const calls: {prompt: string; maxTokens?: number; streamed: boolean}[] = [];
		const tokensOf = (text: string) => Math.ceil(text.length / (charsPerToken ?? 4.65)) + 10;
		const complete = vi.fn(async (prompt: string, options: {onToken?: (t: string, f: string) => void; maxTokens?: number}) => {
			calls.push({prompt, maxTokens: options.maxTokens, streamed: options.onToken !== undefined});
			const text = `S${calls.length}`.padEnd(summaryLength, '.');
			options.onToken?.(text, text);
			return {text, promptTokens: charsPerToken === null ? undefined : tokensOf(prompt)};
		});
		return {complete, calls, prompts: () => calls.map(call => call.prompt), tokensOf};
	}

	const library = (count: number) => Array.from({length: count}, (_, i) => words(`n${i}.md`, 100));

	// What fits in one request is sent exactly as Summarize always sent it.
	it('sends what fits as a single request, worded as before', async () => {
		const model = fakeModel();
		const notes = [note('a.md', 10), note('b.md', 10)];
		const onProgress = vi.fn();

		const result = await summarizeNotes({notes, windowTokens: 8192, complete: model.complete, onProgress, onToken: () => {}});

		expect(model.calls).toEqual([{prompt: composeSummarizePrompt(partText(notes)), maxTokens: undefined, streamed: true}]);
		expect(onProgress).not.toHaveBeenCalled();
		expect(result).toEqual({summary: 'S1'.padEnd(20, '.'), parts: 1});
	});

	it('asks for a bare summary with no notes, as before', async () => {
		const model = fakeModel();

		await summarizeNotes({notes: [], windowTokens: 8192, complete: model.complete});

		expect(model.prompts()).toEqual(['Please summarize.']);
	});

	it('summarises each part, then combines the summaries', async () => {
		const model = fakeModel({charsPerToken: null});
		const notes = [note('a.md', 1500), note('b.md', 1500), note('c.md', 1500)];

		const result = await summarizeNotes({notes, windowTokens: 1024, complete: model.complete, onToken: () => {}});

		expect(result.parts).toBe(3);
		expect(model.prompts().slice(0, 3)).toEqual(notes.map((n, i) => composePartSummaryPrompt(i + 1, 3, partText([n]))));
		expect(model.prompts()[3]).toBe(composeCombinePrompt(['S1', 'S2', 'S3'].map(s => s.padEnd(20, '.'))));
		expect(result.summary).toBe('S4'.padEnd(20, '.'));
	});

	// A partial summary only needs a few hundred tokens; capping it keeps the room it needs small,
	// and keeps a talkative model from spending seconds on it. The final summary is the answer.
	it('caps the partial summaries, but not the final one', async () => {
		const model = fakeModel();

		await summarizeNotes({notes: library(30), windowTokens: 1024, complete: model.complete, onToken: () => {}});

		expect(model.calls.slice(0, -1).every(call => call.maxTokens === PART_SUMMARY_TOKENS)).toBe(true);
		expect(model.calls.at(-1)).toMatchObject({maxTokens: undefined, streamed: true});
		expect(model.calls.slice(0, -1).every(call => !call.streamed)).toBe(true);
	});

	it('reports progress before each part and when all are done', async () => {
		const model = fakeModel({charsPerToken: null});
		const onProgress = vi.fn();

		await summarizeNotes({notes: [note('a.md', 1500), note('b.md', 1500)], windowTokens: 1024, complete: model.complete, onProgress});

		expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
			{done: 0, total: 2},
			{done: 1, total: 2},
			{done: 2, total: 2},
		]);
	});

	describe('sizing the parts from the server\'s token count', () => {
		// Three characters a token is safe for any text; this text runs at 4.65.
		it('sizes the first part cautiously, then the rest from what the server counted', async () => {
			const model = fakeModel({charsPerToken: 4.65});

			await summarizeNotes({notes: library(30), windowTokens: 1024, complete: model.complete});

			const [first, second] = model.prompts();
			expect(second.length).toBeGreaterThan(first.length * 1.25);
		});

		// Denser text, such as code or other scripts, has fewer characters a token than assumed.
		it('shrinks the parts when the text is denser than assumed', async () => {
			const model = fakeModel({charsPerToken: 2});

			await summarizeNotes({notes: library(30), windowTokens: 1024, complete: model.complete});

			const [first, second] = model.prompts();
			expect(second.length).toBeLessThan(first.length);
		});

		it('stays cautious when the server does not say', async () => {
			const model = fakeModel({charsPerToken: null});

			await summarizeNotes({notes: library(30), windowTokens: 1024, complete: model.complete});

			const parts = model.calls.filter(call => call.prompt.startsWith('This is part')).map(call => call.prompt.length);
			expect(Math.max(...parts.slice(0, -1)) - Math.min(...parts.slice(0, -1))).toBeLessThan(200);
		});

		it('re-estimates the number of parts as it learns', async () => {
			const model = fakeModel({charsPerToken: 4.65});
			const onProgress = vi.fn();

			await summarizeNotes({notes: library(30), windowTokens: 1024, complete: model.complete, onProgress});

			const totals = onProgress.mock.calls.map(([progress]) => progress.total);
			expect(totals.at(-1)).toBeLessThan(totals[0]);
		});

		// The point of the margin: what the server counts, plus the answer, stays within the window.
		it.each([1024, 2048, 8192])('keeps every request within a %i-token window', async windowTokens => {
			const model = fakeModel({charsPerToken: 4.65, summaryLength: 400});

			await summarizeNotes({notes: library(120), windowTokens, complete: model.complete});

			for (const call of model.calls) {
				const answerRoom = call.maxTokens ?? Math.max(512, windowTokens / 4);
				expect(model.tokensOf(call.prompt) + answerRoom).toBeLessThanOrEqual(windowTokens);
			}
		});
	});

	// Summaries too long to combine at once are combined in batches, and those again.
	it('combines in rounds when the summaries do not fit together', async () => {
		const model = fakeModel({summaryLength: 300, charsPerToken: null});
		const notes = Array.from({length: 6}, (_, i) => note(`n${i}.md`, 1500));

		const result = await summarizeNotes({notes, windowTokens: 1024, complete: model.complete, onToken: () => {}});

		expect(model.calls.length).toBeGreaterThan(7);
		expect(model.calls.at(-1)?.streamed).toBe(true);
		expect(result.summary).toBe(`S${model.calls.length}`.padEnd(300, '.'));
	});

	// Five bullets take ~170 tokens, so a part's cap can be tight; a combined summary of several
	// parts needs more room, or it would be cut off part-way.
	it('caps parts tighter than intermediate combines', async () => {
		const model = fakeModel({summaryLength: 300, charsPerToken: null});
		const notes = Array.from({length: 6}, (_, i) => note(`n${i}.md`, 1500));

		await summarizeNotes({notes, windowTokens: 1024, complete: model.complete, onToken: () => {}});

		const capOf = (prefix: string) => model.calls.filter(c => c.prompt.startsWith(prefix) && !c.streamed).map(c => c.maxTokens);
		expect(PART_SUMMARY_TOKENS).toBe(300);
		expect(new Set(capOf('This is part'))).toEqual(new Set([PART_SUMMARY_TOKENS]));
		expect(new Set(capOf('These are summaries'))).toEqual(new Set([COMBINE_SUMMARY_TOKENS]));
		expect(COMBINE_SUMMARY_TOKENS).toBeGreaterThan(PART_SUMMARY_TOKENS);
	});

	// A model whose summaries never shrink would combine forever; stop and say why.
	it('gives up when a summary cannot fit a request on its own', async () => {
		const model = fakeModel({summaryLength: 5000, charsPerToken: null});

		await expect(summarizeNotes({notes: [note('a.md', 1500), note('b.md', 1500)], windowTokens: 1024, complete: model.complete}))
			.rejects.toThrow(/too large to summarize/);
	});

	// Each summary fits alone but no two fit together, so every round just restates them.
	it('gives up after a few rounds when the summaries will not shrink', async () => {
		const model = fakeModel({summaryLength: 800, charsPerToken: null});

		await expect(summarizeNotes({notes: [note('a.md', 1500), note('b.md', 1500)], windowTokens: 1024, complete: model.complete}))
			.rejects.toThrow(/too large to summarize/);
		// Two parts, then two singleton combines for each of the rounds before the cap.
		expect(model.complete).toHaveBeenCalledTimes(2 + 2 * (MAX_COMBINE_LEVELS - 1));
	});

	it('stops at an abort, sending nothing more', async () => {
		const model = fakeModel({charsPerToken: null});
		model.complete.mockImplementationOnce(async () => ({text: 'S1', promptTokens: undefined}));
		model.complete.mockImplementationOnce(async () => {
			throw new DOMException('Stopped', 'AbortError');
		});

		await expect(summarizeNotes({notes: [note('a.md', 1500), note('b.md', 1500), note('c.md', 1500)], windowTokens: 1024, complete: model.complete}))
			.rejects.toMatchObject({name: 'AbortError'});
		expect(model.complete).toHaveBeenCalledTimes(2);
	});
});
