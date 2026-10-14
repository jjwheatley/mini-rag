import {trimSlash} from "./settings";

// Chunking and embedding-cache keying. Extracted from Contextualizer so it can be unit-tested
// without a plugin instance or a vault — the logic is pure string handling.

// Chunking strategy version — bump whenever chunkText/splitAtBoundary or the
// size constants below change, so stale chunks are invalidated automatically.
export const CHUNKING_VERSION = 1;

export const MAX_CHUNK_SIZE = 1200;
export const MIN_CHUNK_SIZE = 10;

// cyrb53: fast, non-cryptographic 53-bit string hash. Used only for cache keying,
// where collisions just cause a (rare, harmless) unnecessary re-embed.
export function cyrb53(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export interface EmbeddingCacheKeyParts {
	content: string;
	chunkingVersion: number;
	/** Which backend produced the vectors. A same-named model on another is a different space. */
	providerId: string;
	/** The resolved embedding model name. */
	model: string;
	/**
	 * Where the vectors came from. For llama-server the model name is often a placeholder, so the
	 * endpoint is the only reliable way to tell two differently loaded models apart.
	 */
	endpoint: string;
}

/**
 * Cache key for one file's chunks. A mismatch means recompute.
 *
 * The provider and endpoint are part of it: without them, two backends serving a same-named model
 * would share entries across vector spaces, which VectorIndex degrades to "nothing relevant"
 * rather than an error.
 */
export function embeddingCacheKey(parts: EmbeddingCacheKeyParts): string {
	const endpoint = trimSlash(parts.endpoint);
	return cyrb53(`${parts.content}|${parts.chunkingVersion}|${parts.providerId}|${parts.model}|${endpoint}`);
}

/** Splits one note into embeddable chunks, each prefixed with its filename. */
export function chunkText(path: string, text: string): string[] {
	const filename = path.split('/').pop() ?? path;
	// Split on markdown headings, keeping the heading with its section.
	// Prepending \n ensures a heading at position 0 is captured by the lookahead.
	const sections = ('\n' + text).split(/(?=\n#{1,6} )/).map(s => s.replace(/^\n/, ''));
	const chunks: string[] = [];

	for (const section of sections) {
		const trimmed = section.trim();
		if (trimmed.length < MIN_CHUNK_SIZE) continue;

		if (trimmed.length <= MAX_CHUNK_SIZE) {
			chunks.push(`[${filename}]\n${trimmed}`);
		} else {
			// Split oversized sections by double newlines, then cap each sub-chunk
			for (const sub of trimmed.split(/\n\n+/)) {
				const s = sub.trim();
				if (s.length < MIN_CHUNK_SIZE) continue;
				for (const piece of splitAtBoundary(s)) {
					chunks.push(`[${filename}]\n${piece}`);
				}
			}
		}
	}

	return chunks;
}

/** Caps a run of text at MAX_CHUNK_SIZE, preferring to break at a space. */
export function splitAtBoundary(text: string): string[] {
	if (text.length <= MAX_CHUNK_SIZE) return [text];
	const pieces: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = start + MAX_CHUNK_SIZE;
		if (end < text.length) {
			const spaceIdx = text.lastIndexOf(' ', end);
			if (spaceIdx > start) end = spaceIdx;
		}
		const piece = text.slice(start, end).trim();
		if (piece.length >= MIN_CHUNK_SIZE) pieces.push(piece);
		start = end + 1;
	}
	return pieces;
}
