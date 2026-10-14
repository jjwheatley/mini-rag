import {describe, expect, it, vi} from 'vitest';
import {handleIndexBuildError, IndexBuildErrorDeps} from '../src/classes/index-build';
import {
	EmbeddingDimensionMismatchError,
	EmbeddingsUnsupportedError,
	NoModelChosenError,
	ProviderError,
	ProviderUnreachableError,
} from '../src/providers/errors';

function makeDeps(overrides: Partial<IndexBuildErrorDeps> = {}) {
	const deps: IndexBuildErrorDeps = {
		dedicated: false,
		embeddingModel: 'nomic-embed-text',
		showIndexError: vi.fn(),
		notify: vi.fn(),
		formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
		...overrides,
	};
	return deps;
}

describe('handleIndexBuildError', () => {
	// Whether or not the model is dedicated, the fix is the same: choose one.
	it.each([false, true])('asks for a model to be chosen when there is none (dedicated: %s)', dedicated => {
		const deps = makeDeps({dedicated, embeddingModel: ''});

		expect(handleIndexBuildError(new NoModelChosenError(), deps)).toBe('shown');
		expect(deps.showIndexError).toHaveBeenCalledWith('');
		expect(deps.notify).not.toHaveBeenCalled();
	});

	describe('with a dedicated embedding model', () => {
		// A dedicated model that fails is actionable: the user can install it.
		it('shows the install panel for the configured model', () => {
			const deps = makeDeps({dedicated: true, embeddingModel: 'bge-m3'});

			expect(handleIndexBuildError(new Error('boom'), deps)).toBe('shown');
			expect(deps.showIndexError).toHaveBeenCalledWith('bge-m3');
			expect(deps.notify).not.toHaveBeenCalled();
		});

		it('shows the panel when the dedicated model cannot embed', () => {
			const deps = makeDeps({dedicated: true});

			expect(handleIndexBuildError(new EmbeddingsUnsupportedError('m', 'ollama'), deps)).toBe('shown');
			expect(deps.showIndexError).toHaveBeenCalled();
		});

		// A size mismatch is not a missing model: the install panel would send the user the wrong
		// way. The notice explains that the model changed and that a rebuild will fix it.
		it('notifies a dimension mismatch instead of showing the install panel', () => {
			const deps = makeDeps({dedicated: true});

			expect(handleIndexBuildError(new EmbeddingDimensionMismatchError(768, 384), deps)).toBe('notified');
			expect(deps.showIndexError).not.toHaveBeenCalled();
			expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('768'));
		});
	});

	describe('without a dedicated embedding model', () => {
		// The V1 fallback: the chat model cannot embed, so the index stays empty and the whole
		// context is injected into the prompt instead. Nothing to tell the user about.
		it('falls back silently when the model cannot embed', () => {
			const deps = makeDeps();

			expect(handleIndexBuildError(new EmbeddingsUnsupportedError('llama3', 'ollama'), deps)).toBe('fallback');
			expect(deps.notify).not.toHaveBeenCalled();
			expect(deps.showIndexError).not.toHaveBeenCalled();
		});

		it('notifies for any other error', () => {
			const deps = makeDeps();

			expect(handleIndexBuildError(new Error('disk on fire'), deps)).toBe('notified');
			expect(deps.notify).toHaveBeenCalledWith('Mini-RAG: failed to build index — disk on fire');
		});

		it('notifies for an unreachable server rather than falling back', () => {
			const deps = makeDeps();

			expect(handleIndexBuildError(new ProviderUnreachableError('http://x', 'refused'), deps)).toBe('notified');
		});

		it('notifies for a generic provider error', () => {
			const deps = makeDeps();

			expect(handleIndexBuildError(new ProviderError('server said no'), deps)).toBe('notified');
		});

		it('routes the message through the provider formatter', () => {
			const deps = makeDeps({formatError: () => 'friendly GPU guidance'});

			handleIndexBuildError(new Error('raw cuda text'), deps);

			expect(deps.notify).toHaveBeenCalledWith('Mini-RAG: failed to build index — friendly GPU guidance');
		});

		it.each([null, undefined, 'a string', 42])('handles a non-Error rejection (%s)', value => {
			const deps = makeDeps();

			expect(handleIndexBuildError(value, deps)).toBe('notified');
			expect(deps.notify).toHaveBeenCalled();
		});
	});
});
