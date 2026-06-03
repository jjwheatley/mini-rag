import MiniRagPlugin from "../../main";
import {TAbstractFile, TFile, TFolder} from "obsidian";
import {VectorIndex} from "./vector-index";
import {OllamaWrapper} from "./ollama-wrapper";
import {RAG_CONTEXT_TEMPLATE} from "../constants";

const MAX_CHUNK_SIZE = 1200;
const MIN_CHUNK_SIZE = 10;

export class Contextualizer {
	plugin: MiniRagPlugin;
	private contextPaths: Map<string, string>;
	private index: VectorIndex;

	constructor(plugin: MiniRagPlugin) {
		this.plugin = plugin;
		this.contextPaths = new Map();
		this.index = new VectorIndex();
	}

	async addFileToContext(file: TAbstractFile) {
		if (!this.contextPaths.has(file.path)) {
			const content = await this.plugin.fileManager.readFileText(file.path);
			this.contextPaths.set(file.path, content);
		}
	}

	async addFolderToContext(folder: TFolder) {
		const files = this.recurseChildren(folder);
		for (const f of files) {
			try {
				await this.addFileToContext(f);
			} catch {
				// skip unreadable files
			}
		}
	}

	private recurseChildren(file: TAbstractFile): TFile[] {
		const res: TFile[] = [];
		if (file instanceof TFolder) {
			for (const f of file.children) {
				if (f instanceof TFile) {
					if (f.extension === 'md') res.push(f);
				} else {
					res.push(...this.recurseChildren(f));
				}
			}
		} else if (file instanceof TFile && file.extension === 'md') {
			res.push(file);
		}
		return res;
	}

	async buildIndex(ai: OllamaWrapper): Promise<void> {
		this.index.clear();

		const chunks: {path: string; text: string}[] = [];
		for (const [path, text] of this.contextPaths) {
			for (const chunkText of this.chunkText(path, text)) {
				chunks.push({path, text: chunkText});
			}
		}

		if (chunks.length === 0) return;

		const embeddings = await ai.getEmbeddings(chunks.map(c => c.text));
		for (let i = 0; i < chunks.length; i++) {
			this.index.add({path: chunks[i].path, text: chunks[i].text, embedding: embeddings[i]});
		}
	}

	hasIndex(): boolean {
		return this.index.size > 0;
	}

	hasContext(): boolean {
		return this.contextPaths.size > 0;
	}

	getRawContext(): string {
		const parts: string[] = [];
		for (const [path, text] of this.contextPaths) {
			const filename = path.split('/').pop() ?? path;
			parts.push(`[${filename}]\n${text}`);
		}
		return parts.join('\n\n---\n\n');
	}

	getRelevantContext(queryEmbedding: number[], topK: number): string {
		const chunks = this.index.query(queryEmbedding, topK);
		if (chunks.length === 0) return '';
		return RAG_CONTEXT_TEMPLATE + chunks.map(c => c.text).join('\n\n---\n\n');
	}

	getAllContext(): string {
		const chunks = this.index.allChunks();
		if (chunks.length === 0) return '';
		return chunks.map(c => c.text).join('\n\n---\n\n');
	}

	private chunkText(path: string, text: string): string[] {
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
					for (const piece of this.splitAtBoundary(s)) {
						chunks.push(`[${filename}]\n${piece}`);
					}
				}
			}
		}

		return chunks;
	}

	private splitAtBoundary(text: string): string[] {
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
}
