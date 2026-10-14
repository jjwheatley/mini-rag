// Summarising notes too large for one request: summarise parts that each fit the chat model's
// window, then combine the summaries, in rounds if they do not fit together. Pure but for the
// injected `complete`, so the staging is testable without a model.
//
// Most of the time goes on the model writing, and on the number of requests, so parts are as big
// as the window allows: filled to the brim, with only a small, capped allowance for each partial
// summary, and sized from the server's own count of the tokens each request took.

import {CHARS_PER_TOKEN, ContextNote, contextCharBudget, fitNotes} from "./context-budget";
import {
	composeCombinePrompt,
	composePartSummaryPrompt,
	composeSummarizePrompt,
	SUMMARIZE_PREFIX,
} from "./prompt";

/** Rounds of combining before giving up on summaries that will not shrink to fit. */
export const MAX_COMBINE_LEVELS = 4;

/**
 * The longest a partial summary may run. Five short bullet points come to about 170 tokens; the
 * cap stops a model that runs on, and is all the room a part needs to leave.
 */
export const PART_SUMMARY_TOKENS = 300;

/** The longest an intermediate combined summary may run: several parts' worth, so more room. */
export const COMBINE_SUMMARY_TOKENS = 512;

/** Slack in a capped request for the chat template's own tokens. */
const TEMPLATE_TOKENS = 128;

/** How far a measured characters-per-token is trusted: a little short, to stay inside the window. */
const CALIBRATION_MARGIN = 0.9;

/** The least of a part worth filling with the start of the next note, rather than starting anew. */
const MIN_FILL_SHARE = 0.2;

type OnToken = (token: string, fullText: string) => void;

export interface SummarizeProgress {
	/** Parts summarised so far. */
	done: number;
	/** The parts expected in all — an estimate, which shrinks or grows as the sizing is refined. */
	total: number;
}

export interface SummarizeOptions {
	notes: ContextNote[];
	/** The chat model's context window, in tokens. */
	windowTokens: number;
	/**
	 * Sends one request outside the conversation, streaming to `onToken` when given and stopping
	 * at `maxTokens`. Returns the answer, and the prompt's token count when the server reports it.
	 */
	complete: (
		prompt: string,
		options: {onToken?: OnToken; maxTokens?: number},
	) => Promise<{text: string; promptTokens?: number}>;
	/** Called before each part, and once all are done. Not called when one request suffices. */
	onProgress?: (progress: SummarizeProgress) => void;
	/** Receives the final summary as it streams; the parts are not streamed. */
	onToken?: OnToken;
}

/** A note waiting to be summarised: whole, or what remains of one already partly taken. */
interface PendingNote extends ContextNote {
	/** For a remainder: the note's own name, and how many pieces of it were taken already. */
	base?: string;
	piece?: number;
}

/** Room the part instruction takes, allowing for the largest part numbers it could carry. */
const PART_PROMPT_OVERHEAD = composePartSummaryPrompt(9999, 9999, '').length;

const NOTE_SEPARATOR_LENGTH = '\n\n---\n\n'.length;

const TOO_LARGE = 'These notes are too large to summarize within the model\'s context window.';

/**
 * Takes up to `maxChars` from the start of text: up to the last paragraph break before the limit,
 * else the last space, else wherever the limit falls. Returns that and what is left; only
 * whitespace at the cut is dropped.
 */
function takeText(text: string, maxChars: number): [string, string] {
	const limit = Math.max(1, Math.floor(maxChars));
	// Starting on a non-space means whatever precedes a break is never empty.
	const source = text.trimStart();
	if (source.length <= limit) return [source, ''];
	let cut = source.lastIndexOf('\n\n', limit);
	if (cut <= 0) cut = source.lastIndexOf(' ', limit);
	if (cut <= 0) cut = limit;
	return [source.slice(0, cut).trimEnd(), source.slice(cut).trimStart()];
}

/**
 * Cuts text into pieces of at most `maxChars` at natural breaks. Unlike the chunker's splitter,
 * which may discard scraps, a summary should cover every word, so nothing but whitespace is lost.
 */
export function splitText(text: string, maxChars: number): string[] {
	const pieces: string[] = [];
	let rest = text;
	while (rest) {
		const [head, tail] = takeText(rest, maxChars);
		pieces.push(head);
		rest = tail;
	}
	return pieces;
}

const labelLength = (name: string) => `[${name}]\n`.length;

/**
 * Takes the next part from the front of the queue: whole notes while they fit `budgetChars`, then
 * the start of the next note to fill what is left — unless that is under a fifth of the part,
 * which would only end it with a scrap. A note cut this way continues, numbered, in the next part.
 */
export function takePart(queue: PendingNote[], budgetChars: number): {part: ContextNote[]; rest: PendingNote[]} {
	const part: ContextNote[] = [];
	let used = 0;

	for (let i = 0; i < queue.length; i++) {
		const note = queue[i];
		const separator = part.length > 0 ? NOTE_SEPARATOR_LENGTH : 0;
		const name = note.piece ? `${note.base} (part ${note.piece + 1})` : note.name;
		const cost = separator + labelLength(name) + note.text.length;
		if (used + cost <= budgetChars) {
			part.push({name, text: note.text});
			used += cost;
			continue;
		}

		const room = budgetChars - used - separator;
		if (part.length > 0 && room < MIN_FILL_SHARE * budgetChars) {
			return {part, rest: queue.slice(i)};
		}
		const base = note.base ?? note.name;
		const piece = (note.piece ?? 0) + 1;
		const pieceName = `${base} (part ${piece})`;
		const [head, tail] = takeText(note.text, room - labelLength(pieceName));
		// Only trailing whitespace overflowed: the note fits after all, under its own name.
		if (!tail) {
			part.push({name, text: head});
			return {part, rest: queue.slice(i + 1)};
		}
		part.push({name: pieceName, text: head});
		return {part, rest: [{name: base, text: tail, base, piece}, ...queue.slice(i + 1)]};
	}
	return {part, rest: []};
}

/** Every part the notes would make at `budgetChars`, as takePart would take them. */
export function planParts(notes: PendingNote[], budgetChars: number): ContextNote[][] {
	const parts: ContextNote[][] = [];
	let rest = notes;
	while (rest.length > 0) {
		const next = takePart(rest, budgetChars);
		parts.push(next.part);
		rest = next.rest;
	}
	return parts;
}

/**
 * Summarises the notes within the window. What fits in one request goes as one, worded exactly as
 * Summarize always was. Otherwise each part is summarised in turn — in sequence, since one local
 * model would only queue them — and the summaries combined, the last request streaming.
 *
 * Sizes start from the cautious three characters a token; each request the server counts refines
 * that for the next, so a long run settles at what the text really takes.
 */
export async function summarizeNotes(options: SummarizeOptions): Promise<{summary: string; parts: number}> {
	const {notes, windowTokens, complete, onProgress, onToken} = options;
	let charsPerToken = CHARS_PER_TOKEN;

	/** The most characters a request whose answer is capped at `answerTokens` may carry. */
	const cappedBudget = (answerTokens: number) =>
		Math.max(1, Math.floor((windowTokens - answerTokens - TEMPLATE_TOKENS) * charsPerToken));
	/** The most characters a request may carry when its answer is the full summary. */
	const fullBudget = () => contextCharBudget(windowTokens, 0, charsPerToken);

	const send = async (prompt: string, request: {onToken?: OnToken; maxTokens?: number}) => {
		const {text, promptTokens} = await complete(prompt, request);
		if (promptTokens && promptTokens > 0) {
			charsPerToken = Math.max(1, (prompt.length / promptTokens) * CALIBRATION_MARGIN);
		}
		return text;
	};

	const whole = fitNotes(notes, fullBudget() - SUMMARIZE_PREFIX.length);
	if (whole.included === whole.total && !whole.truncated) {
		return {summary: await send(composeSummarizePrompt(whole.text), {onToken}), parts: 1};
	}

	const summaries: string[] = [];
	let rest: PendingNote[] = notes;
	while (rest.length > 0) {
		const budget = cappedBudget(PART_SUMMARY_TOKENS) - PART_PROMPT_OVERHEAD;
		const total = summaries.length + planParts(rest, budget).length;
		onProgress?.({done: summaries.length, total});
		const next = takePart(rest, budget);
		const prompt = composePartSummaryPrompt(summaries.length + 1, total, fitNotes(next.part, null).text);
		summaries.push(await send(prompt, {maxTokens: PART_SUMMARY_TOKENS}));
		rest = next.rest;
	}
	onProgress?.({done: summaries.length, total: summaries.length});

	return {summary: await combine(summaries), parts: summaries.length};

	/** Combines summaries into one, in batches that fit and then again, until one request will do. */
	async function combine(pending: string[], level = 1): Promise<string> {
		const combined = composeCombinePrompt(pending);
		if (combined.length <= fullBudget()) return send(combined, {onToken});

		const fits = (batch: string[]) => composeCombinePrompt(batch).length <= cappedBudget(COMBINE_SUMMARY_TOKENS);
		// A summary that cannot fit even alone, or summaries that will not shrink, would go round
		// forever.
		if (level >= MAX_COMBINE_LEVELS || pending.some(summary => !fits([summary]))) {
			throw new Error(TOO_LARGE);
		}

		const batches: string[][] = [];
		for (const summary of pending) {
			const last = batches[batches.length - 1];
			if (last && fits([...last, summary])) last.push(summary);
			else batches.push([summary]);
		}

		const next: string[] = [];
		for (const batch of batches) {
			next.push(await send(composeCombinePrompt(batch), {maxTokens: COMBINE_SUMMARY_TOKENS}));
		}
		return combine(next, level + 1);
	}
}
