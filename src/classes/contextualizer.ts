import MiniRagPlugin from "../../main";
import {normalizePath, TAbstractFile, TFile, TFolder} from "obsidian";
import {VectorIndex} from "./vector-index";
import {Chunk} from "./vector-index";
import {OllamaWrapper} from "./ollama-wrapper";
import {RAG_CONTEXT_TEMPLATE} from "../constants";

// Cache format version — bump if the FolderCache shape changes.
const CACHE_VERSION = 2;
// Chunking strategy version — bump whenever chunkText/splitAtBoundary or the
// size constants below change, so stale chunks are invalidated automatically.
const CHUNKING_VERSION = 1;
const CACHE_DIR = normalizePath('.obsidian/plugins/mini-rag/cache');
const CACHE_FILE = '.mini-rag-cache.json';

interface FileCacheEntry {
	// hash(content + CHUNKING_VERSION + embeddingModel) — a mismatch means recompute.
	key: string;
	chunks: Chunk[];
}

interface FolderCache {
	version: number;
	files: Record<string, FileCacheEntry>;
}

const MAX_CHUNK_SIZE = 1200;
const MIN_CHUNK_SIZE = 10;

// cyrb53: fast, non-cryptographic 53-bit string hash. Used only for cache keying,
// where collisions just cause a (rare, harmless) unnecessary re-embed.
function cyrb53(str: string, seed = 0): string {
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

function splitPath(path: string): {folder: string; filename: string} {
	const idx = path.lastIndexOf('/');
	if (idx === -1) return {folder: '', filename: path};
	return {folder: path.slice(0, idx), filename: path.slice(idx + 1)};
}

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
		const model = ai.resolvedEmbeddingModel;
		const cachingEnabled = this.plugin.settings.embeddingCacheEnabled;

		// Group context files by their parent folder — the cache is sharded per folder.
		const byFolder = new Map<string, {path: string; filename: string; content: string}[]>();
		for (const [path, content] of this.contextPaths) {
			const {folder, filename} = splitPath(path);
			if (!byFolder.has(folder)) byFolder.set(folder, []);
			byFolder.get(folder)!.push({path, filename, content});
		}

		const folderCaches = new Map<string, {cache: FolderCache; dirty: boolean}>();
		const reusedChunks: Chunk[] = [];
		// Files whose chunks must be (re)embedded, with the cache key to store afterwards.
		const misses: {path: string; folder: string; filename: string; key: string; chunkTexts: string[]}[] = [];

		for (const [folder, files] of byFolder) {
			// When caching is off we never read from disk — every file is treated as a miss.
			const cache = cachingEnabled
				? await this.loadFolderCache(folder)
				: {version: CACHE_VERSION, files: {}};
			const state = {cache, dirty: false};
			folderCaches.set(folder, state);

			for (const f of files) {
				const key = cyrb53(`${f.content}|${CHUNKING_VERSION}|${model}`);
				const entry = cache.files[f.filename];
				if (entry && entry.key === key) {
					reusedChunks.push(...entry.chunks);
				} else {
					misses.push({path: f.path, folder, filename: f.filename, key, chunkTexts: this.chunkText(f.path, f.content)});
				}
			}
		}

		// Embed every cache-miss chunk across the whole context in one batched call.
		const flatTexts = misses.flatMap(m => m.chunkTexts);
		const embedStart = performance.now();
		const embeddings = flatTexts.length ? await ai.getEmbeddings(flatTexts) : [];
		const embedMs = performance.now() - embedStart;

		// Diagnostic timing — open the dev console (Ctrl+Shift+I) to read it.
		// Shows whether time is going to embedding compute vs. everything else.
		if (flatTexts.length > 0) {
			const perChunk = (embedMs / flatTexts.length).toFixed(1);
			console.log(
				`[Mini-RAG] indexed ${misses.length} file(s), ${flatTexts.length} new chunk(s), ` +
				`${reusedChunks.length} cached chunk(s) reused — embedding took ${(embedMs / 1000).toFixed(1)}s ` +
				`(${perChunk}ms/chunk) on model "${model}"`
			);
		}

		let i = 0;
		for (const m of misses) {
			const chunks: Chunk[] = m.chunkTexts.map(text => ({path: m.path, text, embedding: embeddings[i++]}));
			for (const c of chunks) this.index.add(c);
			if (cachingEnabled) {
				const state = folderCaches.get(m.folder)!;
				state.cache.files[m.filename] = {key: m.key, chunks};
				state.dirty = true;
			}
		}

		for (const c of reusedChunks) this.index.add(c);

		// Persist only folders that changed (a miss was added, or load() pruned a stale entry).
		if (cachingEnabled) {
			for (const [folder, state] of folderCaches) {
				if (state.dirty) await this.saveFolderCache(folder, state.cache);
			}
		}
	}

	private cacheFilePathFor(folder: string): {dir: string; file: string} {
		const dir = folder ? normalizePath(`${CACHE_DIR}/${folder}`) : CACHE_DIR;
		return {dir, file: normalizePath(`${dir}/${CACHE_FILE}`)};
	}

	private async loadFolderCache(folder: string): Promise<FolderCache> {
		const empty: FolderCache = {version: CACHE_VERSION, files: {}};
		try {
			const adapter = this.plugin.app.vault.adapter;
			const {file} = this.cacheFilePathFor(folder);
			if (!(await adapter.exists(file))) return empty;
			const parsed = JSON.parse(await adapter.read(file)) as FolderCache;
			if (parsed.version !== CACHE_VERSION || !parsed.files) return empty;

			// Garbage-collect entries whose source note no longer exists in the vault.
			for (const filename of Object.keys(parsed.files)) {
				const notePath = folder ? `${folder}/${filename}` : filename;
				if (!this.plugin.app.vault.getFileByPath(notePath)) {
					delete parsed.files[filename];
				}
			}
			return parsed;
		} catch {
			return empty;
		}
	}

	private async saveFolderCache(folder: string, cache: FolderCache): Promise<void> {
		try {
			const adapter = this.plugin.app.vault.adapter;
			const {dir, file} = this.cacheFilePathFor(folder);
			await this.ensureDir(dir);
			await this.ensureGitignore();
			await adapter.write(file, JSON.stringify(cache));
		} catch {
			// Non-critical — a failed write just means this folder re-embeds next time.
		}
	}

	// Write a .gitignore at the cache root so the embedding cache (which contains note
	// text + vectors) is never committed if the vault is a git repo. "!.gitignore" keeps
	// the rule file itself tracked so it survives a clone. Obsidian Sync has no file-based
	// equivalent — exclude the cache via the "Sync installed community plugins" setting.
	private async ensureGitignore(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const path = normalizePath(`${CACHE_DIR}/.gitignore`);
		if (!(await adapter.exists(path))) {
			await adapter.write(path, '*\n!.gitignore\n');
		}
	}

	private async ensureDir(dir: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		let cur = '';
		for (const part of dir.split('/')) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await adapter.exists(cur))) {
				try {
					await adapter.mkdir(cur);
				} catch {
					// Already exists (race) — ignore.
				}
			}
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

		// **Graph-augmented retrieval** \\
		// After vector search, expand context by including chunks from notes that are
		// linked to or from the top results. Improves multi-hop and associative queries.
		if (chunks.length > 0) {
			const retrievedPaths = new Set(chunks.map(c => c.path));
			const linkedPaths = new Set<string>();
			const app = this.plugin.app;

			for (const path of retrievedPaths) {
				const file = app.vault.getFileByPath(path);
				if (!file) continue;

				// Outgoing [[wikilinks]]
				const links = app.metadataCache.getFileCache(file)?.links ?? [];
				for (const link of links) {
					const resolved = app.metadataCache.getFirstLinkpathDest(link.link, path);
					if (resolved) linkedPaths.add(resolved.path);
				}

				// Backlinks — scan resolvedLinks for any file pointing at this path
				for (const [sourcePath, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
					if (targets[path]) linkedPaths.add(sourcePath);
				}
			}

			// Exclude paths already covered by the vector results
			for (const p of retrievedPaths) linkedPaths.delete(p);

			if (linkedPaths.size > 0) {
				const expansion = this.index.queryFromPaths(queryEmbedding, topK, linkedPaths);
				const allChunks = [...chunks, ...expansion];
				return RAG_CONTEXT_TEMPLATE + allChunks.map(c => c.text).join('\n\n---\n\n');
			}
		}

		if (chunks.length === 0)
			return '';

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
