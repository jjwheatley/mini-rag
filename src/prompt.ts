// Prompt decisions, extracted from ChatWindow so they can be unit-tested without an Obsidian
// ItemView, an electron clipboard, or a live model.
//
// Retrieved excerpts no longer get glued onto the question here: they travel to the provider as
// per-turn context (a system message), so the user turn is exactly what was typed.

/** Which context source a turn should draw on. */
export type ContextMode = 'rag' | 'raw' | 'none';

/**
 * An index means embeddings are available, so retrieve. A context without an index means the
 * embedding model could not embed (the V1 fallback), so inject the whole thing. Neither means a
 * context-free chat.
 */
export function selectContextMode(hasIndex: boolean, hasContext: boolean): ContextMode {
	if (hasIndex) return 'rag';
	if (hasContext) return 'raw';
	return 'none';
}

/** What the summary instruction adds ahead of the content, so its length can be budgeted. */
export const SUMMARIZE_PREFIX = 'Please summarize the following content:\n\n';

/** The prompt behind the Summarize button. */
export function composeSummarizePrompt(context: string): string {
	return context ? SUMMARIZE_PREFIX + context : 'Please summarize.';
}

/**
 * The first stage of summarising notes too large for one request: one part of them. Writing is
 * most of each part's time, so the summary is kept short — as a few bullet points, since models
 * keep to a count of items far better than to a count of words.
 */
export function composePartSummaryPrompt(part: number, parts: number, text: string): string {
	return `This is part ${part} of ${parts} of a set of notes. Summarize it in at most 5 short bullet points, ` +
		`keeping the key names and facts:\n\n${text}`;
}

/** The second stage: the partial summaries, combined into one summary of the whole. */
export function composeCombinePrompt(summaries: string[]): string {
	const numbered = summaries.map((summary, i) => `Part ${i + 1}:\n${summary}`).join('\n\n');
	return `These are summaries of ${summaries.length} parts of a set of notes. ` +
		`Combine them into one summary of the whole:\n\n${numbered}`;
}
