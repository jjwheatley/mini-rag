export interface Chunk {
	path: string;
	text: string;
	embedding: number[];
}

export class VectorIndex {
	private chunks: Chunk[] = [];

	add(chunk: Chunk) {
		this.chunks.push(chunk);
	}

	clear() {
		this.chunks = [];
	}

	get size() {
		return this.chunks.length;
	}

	allChunks(): Chunk[] {
		return [...this.chunks];
	}

	query(queryEmbedding: number[], topK: number): Chunk[] {
		return this.chunks
			.map(chunk => ({chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding)}))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map(({chunk}) => chunk);
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
