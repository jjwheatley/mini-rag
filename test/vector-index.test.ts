import {describe, expect, it} from 'vitest';
import {Chunk, VectorIndex} from '../src/classes/vector-index';

const chunk = (path: string, text: string, embedding: number[]): Chunk => ({path, text, embedding});

describe('VectorIndex', () => {
	describe('add / clear / size', () => {
		it('starts empty', () => {
			expect(new VectorIndex().size).toBe(0);
		});

		it('counts added chunks', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			index.add(chunk('b.md', 'b', [0, 1]));
			expect(index.size).toBe(2);
		});

		it('clear() empties the index', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			index.clear();
			expect(index.size).toBe(0);
			expect(index.allChunks()).toEqual([]);
		});
	});

	describe('allChunks', () => {
		it('returns the chunks in insertion order', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'first', [1, 0]));
			index.add(chunk('b.md', 'second', [0, 1]));
			expect(index.allChunks().map(c => c.text)).toEqual(['first', 'second']);
		});

		it('returns a copy, so mutating the result does not affect the index', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));

			const copy = index.allChunks();
			copy.push(chunk('injected.md', 'injected', [0, 1]));
			copy.length = 0;

			expect(index.size).toBe(1);
			expect(index.allChunks().map(c => c.path)).toEqual(['a.md']);
		});
	});

	describe('query', () => {
		it('orders results by descending cosine similarity', () => {
			const index = new VectorIndex();
			index.add(chunk('far.md', 'far', [0, 1]));
			index.add(chunk('near.md', 'near', [1, 0]));
			index.add(chunk('mid.md', 'mid', [1, 1]));

			expect(index.query([1, 0], 3).map(c => c.path)).toEqual(['near.md', 'mid.md', 'far.md']);
		});

		it('is scale invariant — magnitude does not change the ranking', () => {
			const index = new VectorIndex();
			index.add(chunk('scaled.md', 'scaled', [100, 0]));
			index.add(chunk('unit.md', 'unit', [0.5, 0.5]));

			expect(index.query([1, 0], 1).map(c => c.path)).toEqual(['scaled.md']);
		});

		it('slices to topK', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			index.add(chunk('b.md', 'b', [0.9, 0.1]));
			index.add(chunk('c.md', 'c', [0, 1]));

			expect(index.query([1, 0], 2)).toHaveLength(2);
		});

		it('returns everything when topK exceeds the index size', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			expect(index.query([1, 0], 10)).toHaveLength(1);
		});

		it('returns nothing for topK of 0', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			expect(index.query([1, 0], 0)).toEqual([]);
		});

		it('returns nothing from an empty index', () => {
			expect(new VectorIndex().query([1, 0], 3)).toEqual([]);
		});

		// A dimension mismatch scores 0 rather than throwing, so a mismatched chunk sinks to the
		// bottom instead of surfacing an error. That silence is exactly why the multi-provider
		// work needs a cache key that discriminates providers, and a dimension guard on build.
		it('scores a dimension mismatch as 0 rather than throwing', () => {
			const index = new VectorIndex();
			index.add(chunk('mismatch.md', 'wrong dimensions', [1, 0, 0, 0]));
			index.add(chunk('match.md', 'right dimensions', [0.9, 0.1]));

			const results = index.query([1, 0], 2);
			expect(results.map(c => c.path)).toEqual(['match.md', 'mismatch.md']);
		});

		it('still returns mismatched chunks when they are all there is', () => {
			const index = new VectorIndex();
			index.add(chunk('mismatch.md', 'wrong dimensions', [1, 0, 0, 0]));

			expect(index.query([1, 0], 3).map(c => c.path)).toEqual(['mismatch.md']);
		});

		it('scores a zero-magnitude chunk embedding as 0', () => {
			const index = new VectorIndex();
			index.add(chunk('zero.md', 'zero', [0, 0]));
			index.add(chunk('real.md', 'real', [1, 0]));

			expect(index.query([1, 0], 2).map(c => c.path)).toEqual(['real.md', 'zero.md']);
		});

		it('scores everything as 0 for a zero-magnitude query', () => {
			const index = new VectorIndex();
			index.add(chunk('a.md', 'a', [1, 0]));
			index.add(chunk('b.md', 'b', [0, 1]));

			// All scores tie at 0, so insertion order survives the sort.
			expect(index.query([0, 0], 2).map(c => c.path)).toEqual(['a.md', 'b.md']);
		});

		it('ranks an opposing vector below an orthogonal one', () => {
			const index = new VectorIndex();
			index.add(chunk('opposite.md', 'opposite', [-1, 0]));
			index.add(chunk('orthogonal.md', 'orthogonal', [0, 1]));

			expect(index.query([1, 0], 2).map(c => c.path)).toEqual(['orthogonal.md', 'opposite.md']);
		});
	});

	describe('queryFromPaths', () => {
		const populated = () => {
			const index = new VectorIndex();
			index.add(chunk('included.md', 'included best', [1, 0]));
			index.add(chunk('included.md', 'included worse', [0.5, 0.5]));
			index.add(chunk('excluded.md', 'excluded but closest', [1, 0]));
			return index;
		};

		it('filters to the given paths before ranking', () => {
			const results = populated().queryFromPaths([1, 0], 5, new Set(['included.md']));
			expect(results.map(c => c.text)).toEqual(['included best', 'included worse']);
		});

		it('slices to topK after filtering', () => {
			const results = populated().queryFromPaths([1, 0], 1, new Set(['included.md']));
			expect(results.map(c => c.text)).toEqual(['included best']);
		});

		it('returns nothing for an empty path set', () => {
			expect(populated().queryFromPaths([1, 0], 5, new Set())).toEqual([]);
		});

		it('ignores paths that are not in the index', () => {
			const results = populated().queryFromPaths([1, 0], 5, new Set(['absent.md']));
			expect(results).toEqual([]);
		});

		it('matches paths exactly, not by prefix', () => {
			const index = new VectorIndex();
			index.add(chunk('notes/deep.md', 'deep', [1, 0]));

			expect(index.queryFromPaths([1, 0], 5, new Set(['notes']))).toEqual([]);
			expect(index.queryFromPaths([1, 0], 5, new Set(['notes/deep.md']))).toHaveLength(1);
		});
	});
});
