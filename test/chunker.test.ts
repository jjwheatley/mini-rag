import {describe, expect, it} from 'vitest';
import {
	chunkText,
	CHUNKING_VERSION,
	cyrb53,
	embeddingCacheKey,
	MAX_CHUNK_SIZE,
	MIN_CHUNK_SIZE,
	splitAtBoundary,
} from '../src/chunker';

/** Strips the `[filename]\n` prefix so a test can assert on the body alone. */
const bodies = (chunks: string[]) => chunks.map(c => c.slice(c.indexOf('\n') + 1));

describe('chunkText', () => {
	describe('filename prefix', () => {
		it('prefixes each chunk with the basename', () => {
			const chunks = chunkText('notes/deep/Ideas.md', '# Heading\nSome body text here.');
			expect(chunks[0].startsWith('[Ideas.md]\n')).toBe(true);
		});

		it('uses the whole path when there is no separator', () => {
			const chunks = chunkText('Ideas.md', '# Heading\nSome body text here.');
			expect(chunks[0].startsWith('[Ideas.md]\n')).toBe(true);
		});

		// The oversized path re-prefixes every sub-chunk separately, which is easy to lose in a
		// rewrite -- the model then cannot attribute later pieces to a file.
		it('prefixes every sub-chunk of an oversized section, not just the first', () => {
			const paragraph = 'word '.repeat(200).trim();
			const text = `# Big\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;

			const chunks = chunkText('Big.md', text);

			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.every(c => c.startsWith('[Big.md]\n'))).toBe(true);
		});
	});

	describe('heading splitting', () => {
		it('captures a heading at position 0', () => {
			const chunks = chunkText('a.md', '# First heading\nBody of the first section.');
			expect(bodies(chunks)).toEqual(['# First heading\nBody of the first section.']);
		});

		it('keeps each heading with its own section', () => {
			const text = '# One\nFirst section body.\n# Two\nSecond section body.';
			expect(bodies(chunkText('a.md', text))).toEqual([
				'# One\nFirst section body.',
				'# Two\nSecond section body.',
			]);
		});

		it.each([1, 2, 3, 4, 5, 6])('splits on a level-%i heading', level => {
			const hashes = '#'.repeat(level);
			const text = `Leading paragraph body.\n${hashes} Section\nSection body text.`;

			expect(bodies(chunkText('a.md', text))).toEqual([
				'Leading paragraph body.',
				`${hashes} Section\nSection body text.`,
			]);
		});

		it('does not split on a 7-hash line, which is not a heading', () => {
			const text = 'Leading paragraph body.\n####### Not a heading\nMore body text.';
			expect(chunkText('a.md', text)).toHaveLength(1);
		});

		it('does not split on a hash without a following space', () => {
			const text = 'Leading paragraph body.\n#NotAHeading\nMore body text here.';
			expect(chunkText('a.md', text)).toHaveLength(1);
		});

		it('handles a document with no headings as one chunk', () => {
			const chunks = chunkText('a.md', 'Just a paragraph of body text with no headings.');
			expect(bodies(chunks)).toEqual(['Just a paragraph of body text with no headings.']);
		});

		it('trims each section', () => {
			const chunks = chunkText('a.md', '# Heading\n\n   Body text here.   \n\n');
			expect(bodies(chunks)).toEqual(['# Heading\n\n   Body text here.']);
		});
	});

	describe('minimum size', () => {
		it(`drops a section shorter than ${MIN_CHUNK_SIZE} characters`, () => {
			// "# A" trims to 3 characters, under the floor.
			const chunks = chunkText('a.md', '# A\n# Long enough heading\nBody text.');
			expect(bodies(chunks)).toEqual(['# Long enough heading\nBody text.']);
		});

		it('returns nothing for an empty document', () => {
			expect(chunkText('a.md', '')).toEqual([]);
		});

		it('returns nothing for whitespace only', () => {
			expect(chunkText('a.md', '   \n\n   ')).toEqual([]);
		});

		it('returns nothing when every section is too short', () => {
			expect(chunkText('a.md', '# A\n# B\n# C')).toEqual([]);
		});

		it('keeps a section exactly at the minimum length', () => {
			const text = 'x'.repeat(MIN_CHUNK_SIZE);
			expect(bodies(chunkText('a.md', text))).toEqual([text]);
		});
	});

	describe('maximum size', () => {
		it('keeps a section exactly at the maximum length as one chunk', () => {
			const text = 'x'.repeat(MAX_CHUNK_SIZE);
			const chunks = chunkText('a.md', text);
			expect(chunks).toHaveLength(1);
			expect(bodies(chunks)).toEqual([text]);
		});

		it('splits an oversized section on blank lines first', () => {
			const half = 'a'.repeat(700);
			const other = 'b'.repeat(700);
			const chunks = chunkText('a.md', `${half}\n\n${other}`);

			expect(bodies(chunks)).toEqual([half, other]);
		});

		it('collapses runs of more than two newlines when splitting', () => {
			const half = 'a'.repeat(700);
			const other = 'b'.repeat(700);
			expect(bodies(chunkText('a.md', `${half}\n\n\n\n${other}`))).toEqual([half, other]);
		});

		it('drops sub-chunks below the minimum length', () => {
			const big = 'a'.repeat(1300);
			const chunks = chunkText('a.md', `${big}\n\ntiny`);
			expect(bodies(chunks).some(b => b === 'tiny')).toBe(false);
		});

		it('caps every emitted chunk body at the maximum size', () => {
			const paragraph = 'word '.repeat(1000).trim();
			for (const body of bodies(chunkText('a.md', paragraph))) {
				expect(body.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
			}
		});

		it('loses no words when splitting a long run of words', () => {
			const words = Array.from({length: 600}, (_, i) => `w${i}`);
			const chunks = chunkText('a.md', words.join(' '));

			expect(bodies(chunks).join(' ').split(' ')).toEqual(words);
		});
	});

	describe('line endings', () => {
		// The lookahead is on \n, and CRLF contains one, so CRLF headings still split. The \r
		// preceding a heading is trimmed off the end of the previous section, but interior ones
		// survive into the embedded text.
		it('splits CRLF headings and keeps interior carriage returns', () => {
			const chunks = chunkText('a.md', '# One\r\nFirst body.\r\n# Two\r\nSecond body.');

			expect(bodies(chunks)).toEqual(['# One\r\nFirst body.', '# Two\r\nSecond body.']);
		});
	});
});

describe('splitAtBoundary', () => {
	it('returns the text unchanged when it fits', () => {
		expect(splitAtBoundary('short text')).toEqual(['short text']);
	});

	it('returns the text unchanged at exactly the maximum size', () => {
		const text = 'x'.repeat(MAX_CHUNK_SIZE);
		expect(splitAtBoundary(text)).toEqual([text]);
	});

	it('breaks at the last space at or before the cap', () => {
		const first = 'a'.repeat(MAX_CHUNK_SIZE - 1);
		const pieces = splitAtBoundary(`${first} ${'b'.repeat(50)}`);

		expect(pieces[0]).toBe(first);
		expect(pieces[1]).toBe('b'.repeat(50));
	});

	it('never emits a piece longer than the maximum size', () => {
		const text = 'word '.repeat(2000).trim();
		for (const piece of splitAtBoundary(text)) {
			expect(piece.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
		}
	});

	// A single unbroken token has no space to break at, so the cap applies as a hard cut. The
	// guard against an infinite loop here is `spaceIdx > start`.
	it('hard-cuts a single 5000-character word and terminates', () => {
		const pieces = splitAtBoundary('x'.repeat(5000));

		expect(pieces).toHaveLength(Math.ceil(5000 / MAX_CHUNK_SIZE));
		expect(pieces[0]).toHaveLength(MAX_CHUNK_SIZE);
		expect(pieces.join('')).toHaveLength(5000 - (pieces.length - 1));
	});

	it('terminates on a long run of spaces', () => {
		const pieces = splitAtBoundary(' '.repeat(5000));
		expect(pieces).toEqual([]);
	});

	it('drops a trailing remainder below the minimum length', () => {
		const pieces = splitAtBoundary(`${'a'.repeat(MAX_CHUNK_SIZE)} bc`);
		expect(pieces).toEqual(['a'.repeat(MAX_CHUNK_SIZE)]);
	});
});

describe('cyrb53', () => {
	// Fixed vectors: the hash feeds persisted cache keys, so a change to it silently invalidates
	// every user's cache. These values must not drift.
	it('matches known values', () => {
		expect(cyrb53('')).toBe('bdcb81aee8d83');
		expect(cyrb53('hello')).toBe('106f3a63cd7226');
	});

	it('honours the seed', () => {
		expect(cyrb53('hello', 1)).toBe('1897bfcd0b3443');
		expect(cyrb53('hello', 1)).not.toBe(cyrb53('hello'));
	});

	it('is deterministic', () => {
		expect(cyrb53('some note content')).toBe(cyrb53('some note content'));
	});

	it('differs for different inputs', () => {
		expect(cyrb53('a')).not.toBe(cyrb53('b'));
	});

	it('returns lowercase hex', () => {
		expect(cyrb53('some note content')).toMatch(/^[0-9a-f]+$/);
	});
});

describe('embeddingCacheKey', () => {
	const parts = {
		content: 'note content',
		chunkingVersion: 1,
		providerId: 'ollama',
		model: 'nomic-embed-text',
		endpoint: 'http://localhost:11434',
	};

	// The pre-2.3 key hashed only content, version and model. That let two backends serving a
	// same-named model -- different vector spaces -- share cache entries.
	it('hashes content, chunking version, provider, model and endpoint together', () => {
		expect(embeddingCacheKey(parts)).toBe(
			cyrb53('note content|1|ollama|nomic-embed-text|http://localhost:11434'),
		);
	});

	it('is stable across calls', () => {
		expect(embeddingCacheKey(parts)).toBe(embeddingCacheKey({...parts}));
	});

	it.each([
		['content', {content: 'other'}],
		['chunking version', {chunkingVersion: 2}],
		['model', {model: 'bge-m3'}],
		// A same-named model on another backend is a different vector space.
		['provider', {providerId: 'llamacpp'}],
		// llama-server's model field is often a placeholder, so the endpoint is what tells two
		// differently loaded models apart.
		['endpoint', {endpoint: 'http://localhost:8081'}],
	])('changes when the %s changes', (_label, change) => {
		expect(embeddingCacheKey({...parts, ...change})).not.toBe(embeddingCacheKey(parts));
	});

	// "http://host:1/" and "http://host:1" are the same server.
	it('ignores a trailing slash on the endpoint', () => {
		expect(embeddingCacheKey({...parts, endpoint: 'http://localhost:11434/'})).toBe(
			embeddingCacheKey(parts),
		);
	});

	// The separator is what stops adjacent fields bleeding into each other.
	it('does not collide when a field boundary shifts', () => {
		const a = embeddingCacheKey({...parts, content: 'a|1', chunkingVersion: 1});
		const b = embeddingCacheKey({...parts, content: 'a', chunkingVersion: 11});
		expect(a).not.toBe(b);
	});
});

describe('module constants', () => {
	it('exposes the versions and sizes the cache key depends on', () => {
		expect(CHUNKING_VERSION).toBe(1);
		expect(MAX_CHUNK_SIZE).toBe(1200);
		expect(MIN_CHUNK_SIZE).toBe(10);
	});
});
