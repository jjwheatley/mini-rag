import {EmbeddingDimensionMismatchError, EmbeddingsUnsupportedError, NoModelChosenError} from "../providers/errors";

export type IndexBuildOutcome =
	/** The install-hint panel was shown: a dedicated embedding model is missing. */
	| 'shown'
	/** The chat model cannot embed, so retrieval falls back to raw context injection. */
	| 'fallback'
	/** Anything else — surfaced as a notice. */
	| 'notified';

export interface IndexBuildErrorDeps {
	dedicated: boolean;
	embeddingModel: string;
	showIndexError(model: string): void;
	notify(message: string): void;
	formatError(error: unknown): string;
}

/**
 * Decides what a failed index build means for the user.
 *
 * This lived as the same fifteen lines in both main.ts and menu-manager.ts, which is exactly how
 * the old `/status 501/` check ended up duplicated — and why fixing one site and forgetting the
 * other was so easy. Pure given its deps, so it is unit-testable on its own.
 */
export function handleIndexBuildError(error: unknown, deps: IndexBuildErrorDeps): IndexBuildOutcome {
	// No model chosen: the panel asks for one, whichever model it would have been.
	if (error instanceof NoModelChosenError) {
		deps.showIndexError('');
		return 'shown';
	}

	// A size mismatch means the embedding model changed, not that one is missing — the install
	// panel would send the user the wrong way. The caches are already emptied, so a rebuild fixes it.
	if (error instanceof EmbeddingDimensionMismatchError) {
		deps.notify(`Mini-RAG: failed to build index — ${deps.formatError(error)}`);
		return 'notified';
	}

	// A dedicated embedding model that fails is actionable: tell the user how to install it.
	if (deps.dedicated) {
		deps.showIndexError(deps.embeddingModel);
		return 'shown';
	}

	// The chat model doubles as the embedding model and cannot embed. Not an error the user can
	// act on: hasContext() is still true, so the whole context is injected into the prompt.
	if (error instanceof EmbeddingsUnsupportedError) {
		return 'fallback';
	}

	deps.notify(`Mini-RAG: failed to build index — ${deps.formatError(error)}`);
	return 'notified';
}
