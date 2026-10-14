import {describe, expect, it} from 'vitest';
import {
	ASSUMED_CONTEXT_TOKENS,
	CHARS_PER_TOKEN,
	contextCharBudget,
	fitNotes,
	fitNotice,
	resolveWindow,
} from '../src/context-budget';

const SEPARATOR = '\n\n---\n\n';
const notes = (...texts: string[]) => texts.map((text, i) => ({name: `${i}.md`, text}));

describe('contextCharBudget', () => {
	// A quarter of the window is kept for the answer, so 6,144 of 8,192 tokens carry the prompt.
	it('leaves a quarter of the window for the answer', () => {
		expect(contextCharBudget(8192, 0)).toBe(6144 * CHARS_PER_TOKEN);
	});

	it('leaves at least 512 tokens for the answer in a small window', () => {
		expect(contextCharBudget(1024, 0)).toBe(512 * CHARS_PER_TOKEN);
	});

	// The question or summary instruction is always sent, so it comes out of the budget first.
	it('subtracts what is already spoken for', () => {
		expect(contextCharBudget(8192, 100)).toBe(6144 * CHARS_PER_TOKEN - 100);
	});

	// A server's own token count can show the text is lighter or denser than the default guess.
	it('takes a measured number of characters a token', () => {
		expect(contextCharBudget(8192, 0, 4.5)).toBe(6144 * 4.5);
	});

	it('never goes below zero', () => {
		expect(contextCharBudget(1024, 1_000_000)).toBe(0);
	});

	// Under-estimating characters per token keeps the guess on the safe side: real Markdown and
	// prose run nearer four.
	it('assumes three characters per token', () => {
		expect(CHARS_PER_TOKEN).toBe(3);
	});
});

describe('fitNotes', () => {
	it('labels each note with its name and joins them with a rule', () => {
		const fit = fitNotes([{name: 'a.md', text: 'alpha'}, {name: 'b.md', text: 'beta'}], null);

		expect(fit.text).toBe(`[a.md]\nalpha${SEPARATOR}[b.md]\nbeta`);
	});

	it('includes everything when there is no budget', () => {
		expect(fitNotes(notes('x'.repeat(100_000), 'y'), null)).toMatchObject({included: 2, total: 2, truncated: false});
	});

	it('is empty with no notes', () => {
		expect(fitNotes([], 100)).toEqual({text: '', included: 0, total: 0, truncated: false, firstName: undefined});
	});

	it('keeps whole notes, in order, while they fit', () => {
		// "[0.md]\naaaa" is 11 characters; each later note adds the separator too.
		const fit = fitNotes(notes('aaaa', 'bbbb', 'cccc'), 11 + SEPARATOR.length + 11);

		expect(fit.text).toBe(`[0.md]\naaaa${SEPARATOR}[1.md]\nbbbb`);
		expect(fit).toMatchObject({included: 2, total: 3, truncated: false});
	});

	// Skipping a large note to squeeze in a later one would quietly reorder the context.
	it('stops at the first note that does not fit', () => {
		const fit = fitNotes(notes('aaaa', 'x'.repeat(500), 'cc'), 100);

		expect(fit.included).toBe(1);
		expect(fit.text).not.toContain('cc');
	});

	// One note larger than the whole window: its opening is better than nothing.
	it('keeps the start of a single note that is too large on its own', () => {
		const fit = fitNotes(notes('abcdefghij'.repeat(10)), 20);

		expect(fit.text).toBe('[0.md]\nabcdefghijabc');
		expect(fit.text.length).toBe(20);
		expect(fit).toMatchObject({included: 1, total: 1, truncated: true, firstName: '0.md'});
	});

	it('keeps nothing when the budget cannot hold even a note name', () => {
		expect(fitNotes(notes('alpha'), 3)).toMatchObject({text: '', included: 0, truncated: false});
	});

	it('names the first note, for the notice', () => {
		expect(fitNotes([{name: 'only.md', text: 'x'}], null).firstName).toBe('only.md');
	});
});

describe('resolveWindow', () => {
	it('uses the window the server reports', () => {
		expect(resolveWindow(8192)).toEqual({tokens: 8192, assumed: false});
	});

	// Ollama reports nothing, and trims to its default window; sending more is silently lost.
	it.each([null, undefined, 0, -1])('assumes Ollama\'s default when the server reports %s', reported => {
		expect(resolveWindow(reported)).toEqual({tokens: 4096, assumed: true});
	});

	it('assumes 4,096 tokens', () => {
		expect(ASSUMED_CONTEXT_TOKENS).toBe(4096);
	});
});

describe('fitNotice', () => {
	it('says nothing when everything fit', () => {
		expect(fitNotice(fitNotes(notes('a', 'b'), null), {tokens: 8192, assumed: false})).toBeNull();
	});

	it('says when the window was assumed rather than reported', () => {
		const fit = fitNotes(notes('aaaa', 'bbbb', 'cccc'), 11);

		expect(fitNotice(fit, {tokens: 4096, assumed: true})).toBe(
			'Only 1 of 3 notes fit in an assumed 4,096-token context (the server doesn\'t report its own), so the rest were left out.',
		);
	});

	it('counts the notes that fit, and gives the window size', () => {
		const fit = fitNotes(notes('aaaa', 'bbbb', 'cccc'), 11);

		expect(fitNotice(fit, {tokens: 8192, assumed: false})).toBe(
			'Only 1 of 3 notes fit in the model\'s 8,192-token context, so the rest were left out.',
		);
	});

	it('names the note when only its start fit', () => {
		const fit = fitNotes([{name: 'big.md', text: 'x'.repeat(1000)}], 50);

		expect(fitNotice(fit, {tokens: 4096, assumed: false})).toBe(
			'Only the start of big.md fit in the model\'s 4,096-token context, so the rest was left out.',
		);
	});

	it('says when nothing fit at all', () => {
		const fit = fitNotes(notes('alpha', 'beta'), 0);

		expect(fitNotice(fit, {tokens: 512, assumed: false})).toBe(
			'None of the 2 notes fit in the model\'s 512-token context, so they were left out.',
		);
	});
});
