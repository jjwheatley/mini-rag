// Fitting whole-context requests (Summarize, and the no-index fallback) to the chat model's
// context window. Pure, so the arithmetic is testable without a model.
//
// Ollama trims an over-long prompt itself, silently; llama-server refuses it outright. Neither is
// what the user wants, so the context is cut to fit at a note boundary and the chat says what was
// left out — to the window the server reports, or, when it reports none, an assumed one.

/**
 * Characters per token, for estimating. Real Markdown and prose run nearer four; three keeps the
 * guess on the safe side, since an over-estimate is a refused request and an under-estimate is
 * only a little unused room.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * The window to assume when the server reports none. Ollama does not say, and trims anything
 * longer to its default window of 4,096 tokens, silently. Fitting this keeps what is sent from
 * being cut without anyone knowing.
 */
export const ASSUMED_CONTEXT_TOKENS = 4096;

/** A chat model's context window, and whether it was reported by the server or assumed. */
export interface ContextWindow {
	tokens: number;
	assumed: boolean;
}

export function resolveWindow(reported: number | null | undefined): ContextWindow {
	return reported && reported > 0
		? {tokens: reported, assumed: false}
		: {tokens: ASSUMED_CONTEXT_TOKENS, assumed: true};
}

/** The smallest share of the window kept free for the answer. */
const MIN_ANSWER_TOKENS = 512;

const NOTE_SEPARATOR = '\n\n---\n\n';

export interface ContextNote {
	/** The note's file name, used as its label. */
	name: string;
	text: string;
}

export interface FittedNotes {
	text: string;
	/** Notes with any content in `text`, the last of which may be cut short. */
	included: number;
	total: number;
	/** Whether the one included note was cut short because it alone was too large. */
	truncated: boolean;
	firstName: string | undefined;
}

/**
 * How many characters a request can carry in a window of `contextTokens` (see resolveWindow for
 * one the server does not report). A quarter of the window, and at least 512 tokens, is left for
 * the answer; `reservedChars` — the question or instruction that is always sent — comes off too.
 * `charsPerToken` defaults to the cautious estimate; a server's own token count can refine it.
 */
export function contextCharBudget(
	contextTokens: number,
	reservedChars: number,
	charsPerToken = CHARS_PER_TOKEN,
): number {
	const answerTokens = Math.max(MIN_ANSWER_TOKENS, Math.floor(contextTokens / 4));
	return Math.max(0, Math.floor((contextTokens - answerTokens) * charsPerToken) - reservedChars);
}

const label = (note: ContextNote) => `[${note.name}]\n${note.text}`;

/**
 * Labels the notes and joins them, keeping whole notes in order while they fit `budgetChars`.
 * It stops at the first that does not, rather than skipping ahead for a smaller one, so the
 * context is never silently reordered. A first note too large on its own keeps its opening.
 */
export function fitNotes(notes: ContextNote[], budgetChars: number | null): FittedNotes {
	const result: FittedNotes = {text: '', included: 0, total: notes.length, truncated: false, firstName: notes[0]?.name};
	const parts: string[] = [];
	let used = 0;

	for (const note of notes) {
		const part = label(note);
		const cost = part.length + (parts.length > 0 ? NOTE_SEPARATOR.length : 0);
		if (budgetChars !== null && used + cost > budgetChars) {
			// Only the first note is cut down: its opening is better than nothing, whereas a later
			// note's fragment would just crowd the ones before it.
			if (parts.length === 0 && budgetChars > `[${note.name}]\n`.length) {
				parts.push(part.slice(0, budgetChars));
				result.truncated = true;
			}
			break;
		}
		parts.push(part);
		used += cost;
	}

	result.text = parts.join(NOTE_SEPARATOR);
	result.included = parts.length;
	return result;
}

/** What to tell the user about what was left out of a request, or null when nothing was. */
export function fitNotice(fit: FittedNotes, contextWindow: ContextWindow): string | null {
	if (fit.included === fit.total && !fit.truncated) return null;
	const size = contextWindow.tokens.toLocaleString('en-US');
	const window = contextWindow.assumed
		? `an assumed ${size}-token context (the server doesn't report its own)`
		: `the model's ${size}-token context`;
	if (fit.truncated) {
		return `Only the start of ${fit.firstName} fit in ${window}, so the rest was left out.`;
	}
	if (fit.included === 0) {
		return `None of the ${fit.total} notes fit in ${window}, so they were left out.`;
	}
	return `Only ${fit.included} of ${fit.total} notes fit in ${window}, so the rest were left out.`;
}
