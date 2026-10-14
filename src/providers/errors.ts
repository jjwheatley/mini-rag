import {ProviderId} from "../types";

export interface ProviderErrorOptions {
	status?: number;
	/** True when retrying cannot help — a capability problem, not a transient one. */
	permanent?: boolean;
	detail?: string;
}

export class ProviderError extends Error {
	readonly status?: number;
	readonly permanent: boolean;
	readonly detail?: string;

	constructor(message: string, options: ProviderErrorOptions = {}) {
		super(message);
		this.name = 'ProviderError';
		this.status = options.status;
		this.permanent = options.permanent === true;
		this.detail = options.detail;
	}
}

/**
 * The chosen model cannot produce embeddings. Drives the V1 fallback: the index stays empty,
 * hasContext() is still true, and the whole raw context is injected into the prompt instead.
 *
 * This replaces a `/status 501/` regex that had been copy-pasted into three files.
 */
export class EmbeddingsUnsupportedError extends ProviderError {
	readonly model: string;
	readonly providerId: ProviderId;

	constructor(model: string, providerId: ProviderId, detail?: string) {
		super(`Model "${model}" does not support embeddings.`, {
			status: 501,
			permanent: true,
			detail,
		});
		this.name = 'EmbeddingsUnsupportedError';
		this.model = model;
		this.providerId = providerId;
	}
}

/** The model is not installed or loaded. Drives the install-hint panel. */
export class ModelNotAvailableError extends ProviderError {
	readonly model: string;

	constructor(model: string, detail?: string) {
		super(`Model "${model}" is not available.`, {status: 404, permanent: true, detail});
		this.name = 'ModelNotAvailableError';
		this.model = model;
	}
}

/** The server is not reachable — usually not running, or the wrong port. */
export class ProviderUnreachableError extends ProviderError {
	readonly url: string;

	constructor(url: string, detail?: string) {
		super(`Could not reach the server at ${url}.`, {detail});
		this.name = 'ProviderUnreachableError';
		this.url = url;
	}
}

/**
 * Embeddings of two different widths in one index. VectorIndex scores a dimension mismatch as 0
 * rather than throwing, so without this the symptom is "retrieval quietly returns nothing".
 */
export class EmbeddingDimensionMismatchError extends ProviderError {
	constructor(readonly expected: number, readonly received: number) {
		super(
			`Embedding size changed mid-build (expected ${expected}, got ${received}). ` +
			`This usually means the embedding model changed. Rebuild the index to fix it.`,
			{permanent: true},
		);
		this.name = 'EmbeddingDimensionMismatchError';
	}
}

/**
 * Abort detection that does not require a DOMException.
 *
 * `error instanceof DOMException` is already a little fragile across the Electron/Node boundary,
 * and it would be outright wrong for an in-process provider, which cancels by rejecting with a
 * plain Error. Checking the name as well keeps user-initiated cancels from being retried.
 */
/**
 * No model is chosen to create embeddings with, so an index cannot be built. Not a provider's
 * failure: the fix is choosing a model in the settings, not installing one.
 */
export class NoModelChosenError extends Error {
	constructor() {
		super('No model is chosen to create embeddings with.');
		this.name = 'NoModelChosenError';
	}
}

export function isAbortError(error: unknown): boolean {
	if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
		return true;
	}
	return error instanceof Error && error.name === 'AbortError';
}
