import MiniRagPlugin from "../../main";
import {normalizePath, TAbstractFile, TFile, TFolder} from "obsidian";
import {VectorIndex} from "./vector-index";
import {Chunk} from "./vector-index";
import {EmbeddingSource} from "../providers/types";
import {EmbeddingDimensionMismatchError, NoModelChosenError} from "../providers/errors";
import {RAG_CONTEXT_TEMPLATE} from "../constants";
import {chunkText, CHUNKING_VERSION, embeddingCacheKey} from "../chunker";
import {ContextNote, fitNotes} from "../context-budget";

// Cache format version — bump if the FolderCache shape or the key format changes. 3 added the
// provider and embedding endpoint to the key; older caches are discarded wholesale on load.
const CACHE_VERSION = 3;
const CACHE_DIR = normalizePath('.obsidian/plugins/mini-rag/cache');
const CACHE_FILE = '.mini-rag-cache.json';

interface FileCacheEntry {
	// embeddingCacheKey(content, CHUNKING_VERSION, provider, model, endpoint) — a mismatch means recompute.
	key: string;
	chunks: Chunk[];
}

interface FolderCache {
	version: number;
	files: Record<string, FileCacheEntry>;
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

	async buildIndex(ai: EmbeddingSource): Promise<void> {
		this.index.clear();
		// Where the server decides the model (llama.cpp), learn which it runs first: that, not the
		// one chosen, is what the vectors come from and what the cache must be keyed on.
		await ai.identifyRunningModels?.();
		const model = ai.resolvedEmbeddingModel;
		// Every request would fail, and its failure would name no model: say what is missing.
		if (!model && this.contextPaths.size > 0) throw new NoModelChosenError();
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
				const key = embeddingCacheKey({
					content: f.content,
					chunkingVersion: CHUNKING_VERSION,
					providerId: ai.id,
					model,
					endpoint: ai.embeddingEndpoint,
				});
				const entry = cache.files[f.filename];
				if (entry && entry.key === key) {
					reusedChunks.push(...entry.chunks);
				} else {
					misses.push({path: f.path, folder, filename: f.filename, key, chunkTexts: chunkText(f.path, f.content)});
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

		// VectorIndex scores a size mismatch as 0 rather than failing, so mixed sizes would quietly
		// retrieve nothing. It happens when the embedding model changes without the cache key
		// noticing — llama-server restarted on another model under the same name and port. Refuse
		// the build, and empty the caches so the rebuild re-embeds everything consistently.
		const vectors = [...reusedChunks.map(chunk => chunk.embedding), ...embeddings];
		const expected = vectors[0]?.length;
		const mismatch = vectors.find(vector => vector.length !== expected);
		if (mismatch) {
			await this.discardCaches(folderCaches, cachingEnabled);
			throw new EmbeddingDimensionMismatchError(expected as number, mismatch.length);
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

	/** Empties every folder cache this build touched, so the next build re-embeds from scratch. */
	private async discardCaches(
		folderCaches: Map<string, {cache: FolderCache}>,
		cachingEnabled: boolean,
	): Promise<void> {
		if (!cachingEnabled) return;
		for (const [folder, state] of folderCaches) {
			state.cache.files = {};
			await this.saveFolderCache(folder, state.cache);
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

	/** Every note in the context, by file name, in the order added. */
	getContextNotes(): ContextNote[] {
		return [...this.contextPaths].map(([path, text]) => ({name: path.split('/').pop() ?? path, text}));
	}

	getRawContext(): string {
		return fitNotes(this.getContextNotes(), null).text;
	}

	/**
	 * The excerpts most relevant to the query, with the template that introduces them. Within
	 * `maxChars`, the lowest-ranked go first — linked-note excerpts before search results, since the
	 * results are what the question matched — but the best is always kept.
	 */
	getRelevantContext(queryEmbedding: number[], topK: number, maxChars = Infinity): string {
		const results = this.index.query(queryEmbedding, topK);
		const chunks = [...results, ...this.linkedChunks(queryEmbedding, topK, results)];
		if (chunks.length === 0) return '';

		const render = (kept: Chunk[]) => RAG_CONTEXT_TEMPLATE + kept.map(c => c.text).join('\n\n---\n\n');
		while (chunks.length > 1 && render(chunks).length > maxChars) chunks.pop();
		return render(chunks);
	}

	/**
	 * **Graph-augmented retrieval**: chunks from notes linked to or from the top results, best
	 * first. Improves multi-hop and associative queries.
	 */
	private linkedChunks(queryEmbedding: number[], topK: number, results: Chunk[]): Chunk[] {
		const retrievedPaths = new Set(results.map(c => c.path));
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
		return linkedPaths.size > 0 ? this.index.queryFromPaths(queryEmbedding, topK, linkedPaths) : [];
	}

}
