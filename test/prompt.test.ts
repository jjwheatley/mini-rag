import {describe, expect, it} from 'vitest';
import {
	composeCombinePrompt,
	composePartSummaryPrompt,
	composeSummarizePrompt,
	selectContextMode,
} from '../src/prompt';

describe('selectContextMode', () => {
	it('prefers rag when an index exists', () => {
		expect(selectContextMode(true, true)).toBe('rag');
	});

	it('falls back to raw when there is context but no index', () => {
		expect(selectContextMode(false, true)).toBe('raw');
	});

	it('returns none when there is neither', () => {
		expect(selectContextMode(false, false)).toBe('none');
	});

	// Cannot happen today (an index implies a context), but it must not crash if it ever does.
	it('returns rag for an index without a context', () => {
		expect(selectContextMode(true, false)).toBe('rag');
	});
});

describe('composeSummarizePrompt', () => {
	it('wraps the context in the summarize instruction', () => {
		expect(composeSummarizePrompt('ALL CONTEXT')).toBe(
			'Please summarize the following content:\n\nALL CONTEXT',
		);
	});

	it('falls back to a bare instruction for empty context', () => {
		expect(composeSummarizePrompt('')).toBe('Please summarize.');
	});

	it('preserves a multi-line context verbatim', () => {
		const context = '[a.md]\nfirst\n\n---\n\n[b.md]\nsecond';
		expect(composeSummarizePrompt(context)).toBe(
			`Please summarize the following content:\n\n${context}`,
		);
	});
});

// The two stages of summarising a folder too large for one request. Golden, so a wording change is
// deliberate: these words decide how long each partial summary is, and so how many stages it takes.
describe('composePartSummaryPrompt', () => {
	// Measured on Qwen2.5-7B: asked for "at most 200 words" it wrote ~340, and "at most 100" ~240;
	// asked for five bullet points it wrote ~120 words, in half the time. Models keep to a count of
	// items far better than to a count of words.
	it('names the part, asks for a few bullet points, then gives the text', () => {
		expect(composePartSummaryPrompt(3, 16, 'PART TEXT')).toBe(
			'This is part 3 of 16 of a set of notes. Summarize it in at most 5 short bullet points, ' +
			'keeping the key names and facts:\n\nPART TEXT',
		);
	});
});

describe('composeCombinePrompt', () => {
	it('numbers the summaries and asks for one summary of the whole', () => {
		expect(composeCombinePrompt(['First.', 'Second.'])).toBe(
			'These are summaries of 2 parts of a set of notes. ' +
			'Combine them into one summary of the whole:\n\n' +
			'Part 1:\nFirst.\n\nPart 2:\nSecond.',
		);
	});
});
