import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TFile as StubTFile, TFolder as StubTFolder} from './stubs/obsidian';
import type {TFile, TFolder} from 'obsidian';
import {Contextualizer} from '../src/classes/contextualizer';
import {Chunk} from '../src/classes/vector-index';
import {CHUNKING_VERSION, cyrb53, embeddingCacheKey} from '../src/chunker';
import {EmbeddingDimensionMismatchError, NoModelChosenError} from '../src/providers/errors';
import {defaultSettings} from '../src/defaults';
import {PluginSettings} from '../src/types';
import {RAG_CONTEXT_TEMPLATE} from '../src/constants';
import MiniRagPlugin from '../main';
import {EmbeddingSource} from '../src/providers/types';

// Mirrors CACHE_VERSION / CACHE_DIR / CACHE_FILE, which are module-private in contextualizer.ts.
const CACHE_VERSION = 3;
const CACHE_DIR = '.obsidian/plugins/mini-rag/cache';
const CACHE_FILE = '.mini-rag-cache.json';

const cachePathFor = (folder: string) =>
	folder ? `${CACHE_DIR}/${folder}/${CACHE_FILE}` : `${CACHE_DIR}/${CACHE_FILE}`;

/** The key the harness's default provider produces for a note. */
const keyFor = (content: string) => embeddingCacheKey({
	content,
	chunkingVersion: CHUNKING_VERSION,
	providerId: 'ollama',
	model: 'embed-model',
	endpoint: 'http://localhost:11434',
});

/** In-memory vault adapter. Records every call so a test can assert it was never touched. */
class FakeAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();
	reads: string[] = [];
	writes: string[] = [];
	failWritesMatching: RegExp | null = null;

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	async read(path: string): Promise<string> {
		this.reads.push(path);
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`ENOENT: ${path}`);
		return content;
	}

	async write(path: string, content: string): Promise<void> {
		this.writes.push(path);
		if (this.failWritesMatching?.test(path)) throw new Error(`EACCES: ${path}`);
		this.files.set(path, content);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}

	/** The parsed cache for one folder, or undefined if none was written. */
	cache(folder: string): {version: number; files: Record<string, {key: string; chunks: Chunk[]}>} | undefined {
		const raw = this.files.get(cachePathFor(folder));
		return raw ? JSON.parse(raw) : undefined;
	}
}

// The stub classes are what Contextualizer's `instanceof TFolder` compares against at runtime,
// since vitest aliases the obsidian module to them -- but tsc resolves that module to the real
// typings. The cast bridges those two views here, so every call site stays properly typed.
function makeFile(path: string): TFile {
	const file = new StubTFile();
	file.path = path;
	const name = path.split('/').pop() ?? path;
	file.name = name;
	file.extension = name.includes('.') ? (name.split('.').pop() as string) : '';
	file.basename = name.replace(/\.[^.]+$/, '');
	return file as unknown as TFile;
}

function makeFolder(path: string, children: (TFile | TFolder)[]): TFolder {
	const folder = new StubTFolder();
	folder.path = path;
	folder.name = path.split('/').pop() ?? path;
	folder.children = children as unknown as StubTFolder['children'];
	return folder as unknown as TFolder;
}

interface Harness {
	context: Contextualizer;
	adapter: FakeAdapter;
	settings: PluginSettings;
	vaultFiles: Map<string, TFile>;
	links: Map<string, {link: string}[]>;
	resolvedLinks: Record<string, Record<string, number>>;
	/** Registers a note's content so addFileToContext can read it. */
	addNote(path: string, content: string): Promise<void>;
	ai: {
		id: string;
		resolvedEmbeddingModel: string;
		embeddingEndpoint: string;
		getEmbeddings: ReturnType<typeof vi.fn>;
		identifyRunningModels?: () => Promise<void>;
	};
	buildIndex(): Promise<void>;
	/** The indexed chunks, for asserting the embedding-to-chunk mapping directly. */
	indexedChunks(): Chunk[];
}

/**
 * By default getEmbeddings hands back a distinct one-hot vector per chunk, in request order, so a
 * misalignment between the flat embedding array and the per-file chunks is visible rather than
 * merely plausible.
 */
function makeHarness(overrides: Partial<PluginSettings> = {}): Harness {
	const adapter = new FakeAdapter();
	const settings: PluginSettings = {...defaultSettings(), ...overrides};
	const noteContents = new Map<string, string>();
	const vaultFiles = new Map<string, TFile>();
	const links = new Map<string, {link: string}[]>();
	const resolvedLinks: Record<string, Record<string, number>> = {};

	const plugin = {
		settings,
		fileManager: {
			readFileText: async (path: string) => {
				const content = noteContents.get(path);
				if (content === undefined) throw new Error(`no such note: ${path}`);
				return content;
			},
		},
		app: {
			vault: {
				adapter,
				getFileByPath: (path: string) => vaultFiles.get(path) ?? null,
			},
			metadataCache: {
				getFileCache: (file: TFile) => ({links: links.get(file.path) ?? []}),
				getFirstLinkpathDest: (link: string) => vaultFiles.get(link) ?? null,
				resolvedLinks,
			},
		},
	} as unknown as MiniRagPlugin;

	const context = new Contextualizer(plugin);

	const ai = {
		id: 'ollama',
		resolvedEmbeddingModel: 'embed-model',
		embeddingEndpoint: 'http://localhost:11434',
		getEmbeddings: vi.fn(async (texts: string[]) =>
			texts.map((_, i) => Array.from({length: texts.length}, (_, j) => (i === j ? 1 : 0))),
		),
	};

	return {
		context,
		adapter,
		settings,
		vaultFiles,
		links,
		resolvedLinks,
		ai,
		async addNote(path: string, content: string) {
			noteContents.set(path, content);
			const file = makeFile(path);
			vaultFiles.set(path, file);
			await context.addFileToContext(file);
		},
		buildIndex: () => context.buildIndex(ai as unknown as EmbeddingSource),
		// Reaches into the private index on purpose: the embedding-to-chunk mapping is an
		// internal invariant, and asserting it through cosine similarity would only obscure it.
		indexedChunks: () => (context as unknown as {index: {allChunks(): Chunk[]}}).index.allChunks(),
	};
}

/** A note that yields exactly `count` chunks: one heading section each, all above the floor. */
function noteWithChunks(count: number): string {
	return Array.from({length: count}, (_, i) => `# Section ${i}\nBody text for section ${i}.`).join('\n');
}

beforeEach(() => {
	// buildIndex logs a timing diagnostic; keep the test output readable.
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('context membership', () => {
	it('starts with no context and no index', () => {
		const h = makeHarness();
		expect(h.context.hasContext()).toBe(false);
		expect(h.context.hasIndex()).toBe(false);
	});

	it('reports context once a file is added', async () => {
		const h = makeHarness();
		await h.addNote('a.md', 'body text here');
		expect(h.context.hasContext()).toBe(true);
		expect(h.context.hasIndex()).toBe(false);
	});

	it('reports an index once built', async () => {
		const h = makeHarness();
		await h.addNote('a.md', 'body text here');
		await h.buildIndex();
		expect(h.context.hasIndex()).toBe(true);
	});

	it('does not re-read a file already in context', async () => {
		const h = makeHarness();
		await h.addNote('a.md', 'first content');

		// A second add of the same path keeps the original content.
		await h.context.addFileToContext(makeFile('a.md'));

		expect(h.context.getRawContext()).toContain('first content');
	});

	it('adds only markdown files from a folder, recursively', async () => {
		const h = makeHarness();
		// Content is registered for the markdown notes only; b.png has none, so if the recursion
		// tried to read it the add would throw rather than silently skipping.
		await h.addNote('notes/a.md', 'alpha body text');
		await h.addNote('notes/sub/c.md', 'charlie body text');

		const folder = makeFolder('notes', [
			makeFile('notes/a.md'),
			makeFile('notes/b.png'),
			makeFolder('notes/sub', [makeFile('notes/sub/c.md')]),
		]);
		await h.context.addFolderToContext(folder);

		const raw = h.context.getRawContext();
		expect(raw).toContain('alpha body text');
		expect(raw).toContain('charlie body text');
		expect(raw).not.toContain('b.png');
	});

	it('skips unreadable files in a folder rather than failing the whole add', async () => {
		const h = makeHarness();
		await h.addNote('notes/good.md', 'good body text');
		const folder = makeFolder('notes', [makeFile('notes/good.md'), makeFile('notes/missing.md')]);

		await expect(h.context.addFolderToContext(folder)).resolves.toBeUndefined();
		expect(h.context.getRawContext()).toContain('good body text');
	});
});

describe('buildIndex', () => {
	// With nothing to embed with, a request would only fail, and the failure would name no model.
	it('refuses to build without a model, saying so', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		h.ai.resolvedEmbeddingModel = '';

		await expect(h.buildIndex()).rejects.toBeInstanceOf(NoModelChosenError);
		expect(h.ai.getEmbeddings).not.toHaveBeenCalled();
	});

	it('makes no embedding call for an empty context', async () => {
		const h = makeHarness();
		await h.buildIndex();

		expect(h.ai.getEmbeddings).not.toHaveBeenCalled();
		expect(h.context.hasIndex()).toBe(false);
	});

	it('embeds every chunk in one batched call', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		await h.addNote('b.md', noteWithChunks(3));

		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
		expect(h.ai.getEmbeddings.mock.calls[0][0]).toHaveLength(5);
		expect(h.indexedChunks()).toHaveLength(5);
	});

	it('clears a previous index before rebuilding', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));

		await h.buildIndex();
		await h.buildIndex();

		expect(h.indexedChunks()).toHaveLength(2);
	});

	// The flat `i++` walk over one embedding array feeding per-file chunk lists. An off-by-one
	// here silently attaches the wrong vector to a chunk, which degrades retrieval without
	// erroring anywhere. This is also the exact failure an unordered OpenAI `data[]` would cause.
	it('maps each embedding to its own chunk across several files', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		await h.addNote('b.md', noteWithChunks(3));
		await h.addNote('c.md', noteWithChunks(1));

		await h.buildIndex();

		const requested = h.ai.getEmbeddings.mock.calls[0][0] as string[];
		const indexed = h.indexedChunks();
		expect(indexed).toHaveLength(6);

		// Chunk i must carry the one-hot vector for position i in the request.
		for (const chunk of indexed) {
			const position = requested.indexOf(chunk.text);
			expect(position).toBeGreaterThanOrEqual(0);
			expect(chunk.embedding[position]).toBe(1);
			expect(chunk.embedding.filter(v => v === 1)).toHaveLength(1);
		}
	});

	it('attributes each chunk to its own note path', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		await h.addNote('b.md', noteWithChunks(1));

		await h.buildIndex();

		const paths = h.indexedChunks().map(c => c.path);
		expect(paths.filter(p => p === 'a.md')).toHaveLength(2);
		expect(paths.filter(p => p === 'b.md')).toHaveLength(1);
	});

	it('indexes nothing for a note with no chunkable content', async () => {
		const h = makeHarness();
		await h.addNote('tiny.md', '# A');

		await h.buildIndex();

		expect(h.ai.getEmbeddings).not.toHaveBeenCalled();
		expect(h.context.hasIndex()).toBe(false);
	});

	it('propagates an embedding failure', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(1));
		h.ai.getEmbeddings.mockRejectedValueOnce(new Error('Request failed, status 501'));

		await expect(h.buildIndex()).rejects.toThrow('status 501');
	});
});

describe('embedding cache', () => {
	it('never touches the adapter when caching is off', async () => {
		const h = makeHarness({embeddingCacheEnabled: false});
		await h.addNote('a.md', noteWithChunks(2));

		await h.buildIndex();

		expect(h.adapter.reads).toEqual([]);
		expect(h.adapter.writes).toEqual([]);
	});

	it('writes a cache entry per file, keyed on content, version, provider, model and endpoint', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		const content = noteWithChunks(2);
		await h.addNote('a.md', content);

		await h.buildIndex();

		const cache = h.adapter.cache('');
		expect(cache?.version).toBe(CACHE_VERSION);
		expect(cache?.files['a.md'].key).toBe(
			keyFor(content),
		);
		expect(cache?.files['a.md'].chunks).toHaveLength(2);
	});

	it('reuses cached chunks on an unchanged rebuild', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();
		h.ai.getEmbeddings.mockClear();

		await h.buildIndex();

		expect(h.ai.getEmbeddings).not.toHaveBeenCalled();
		expect(h.indexedChunks()).toHaveLength(2);
	});

	it('re-embeds when the note content changes', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();

		// A fresh harness sharing the same adapter simulates a later session with edited content.
		const next = makeHarness({embeddingCacheEnabled: true});
		next.adapter.files = h.adapter.files;
		await next.addNote('a.md', noteWithChunks(3));
		await next.buildIndex();

		expect(next.ai.getEmbeddings).toHaveBeenCalledTimes(1);
		expect(next.adapter.cache('')?.files['a.md'].chunks).toHaveLength(3);
	});

	it('re-embeds when the embedding model changes', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();
		h.ai.getEmbeddings.mockClear();

		h.ai.resolvedEmbeddingModel = 'a-different-model';
		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	// A same-named model on another backend is a different vector space.
	it('re-embeds when the provider changes', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();
		h.ai.getEmbeddings.mockClear();

		h.ai.id = 'llamacpp';
		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	// llama-server answers as whatever it runs, so that is what the cache must be keyed on: a cache
	// made under the chosen name would otherwise be taken for the running model's.
	it('asks which model is running before keying the cache', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();
		h.ai.getEmbeddings.mockClear();

		h.ai.identifyRunningModels = vi.fn(async () => {
			h.ai.resolvedEmbeddingModel = 'the-model-actually-running';
		});
		await h.buildIndex();

		expect(h.ai.identifyRunningModels).toHaveBeenCalledTimes(1);
		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	// llama-server's model name is often a placeholder; the port is what distinguishes models.
	it('re-embeds when the embedding endpoint changes', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();
		h.ai.getEmbeddings.mockClear();

		h.ai.embeddingEndpoint = 'http://localhost:8081';
		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	// Caches written before keys named the provider carry the old key format. The version bump
	// discards them wholesale instead of leaving dead vectors and note text on disk.
	it('discards a cache written before keys named the provider', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		const content = noteWithChunks(1);
		await h.addNote('a.md', content);
		h.adapter.files.set(
			cachePathFor(''),
			JSON.stringify({
				version: 2,
				files: {
					'a.md': {
						key: cyrb53(`${content}|${CHUNKING_VERSION}|embed-model`),
						chunks: [{path: 'a.md', text: 'stale', embedding: [9]}],
					},
				},
			}),
		);

		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
		expect(h.indexedChunks().some(c => c.text === 'stale')).toBe(false);
		expect(h.adapter.cache('')?.version).toBe(CACHE_VERSION);
	});

	it('treats a cache from a different version as empty', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		const content = noteWithChunks(2);
		await h.addNote('a.md', content);
		h.adapter.files.set(
			cachePathFor(''),
			JSON.stringify({
				version: CACHE_VERSION + 1,
				files: {
					'a.md': {
						key: keyFor(content),
						chunks: [{path: 'a.md', text: 'stale', embedding: [9]}],
					},
				},
			}),
		);

		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
		expect(h.indexedChunks().some(c => c.text === 'stale')).toBe(false);
	});

	it('treats a cache with no files map as empty', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(1));
		h.adapter.files.set(cachePathFor(''), JSON.stringify({version: CACHE_VERSION}));

		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	it('treats unparseable cache JSON as empty', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(1));
		h.adapter.files.set(cachePathFor(''), 'not json at all');

		await h.buildIndex();

		expect(h.ai.getEmbeddings).toHaveBeenCalledTimes(1);
	});

	it('shards the cache per folder', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('one/a.md', noteWithChunks(1));
		await h.addNote('two/b.md', noteWithChunks(1));

		await h.buildIndex();

		expect(Object.keys(h.adapter.cache('one')?.files ?? {})).toEqual(['a.md']);
		expect(Object.keys(h.adapter.cache('two')?.files ?? {})).toEqual(['b.md']);
	});

	it('writes a .gitignore at the cache root, once', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('one/a.md', noteWithChunks(1));
		await h.addNote('two/b.md', noteWithChunks(1));

		await h.buildIndex();

		const gitignore = `${CACHE_DIR}/.gitignore`;
		expect(h.adapter.files.get(gitignore)).toBe('*\n!.gitignore\n');
		expect(h.adapter.writes.filter(w => w === gitignore)).toHaveLength(1);
	});

	it('still indexes when the cache write fails', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(2));
		h.adapter.failWritesMatching = /mini-rag-cache/;

		await expect(h.buildIndex()).resolves.toBeUndefined();
		expect(h.indexedChunks()).toHaveLength(2);
	});

	it('drops cache entries whose note has left the vault', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		await h.addNote('a.md', noteWithChunks(1));
		await h.addNote('gone.md', noteWithChunks(1));
		await h.buildIndex();
		expect(Object.keys(h.adapter.cache('')?.files ?? {})).toContain('gone.md');

		// The note is deleted from the vault but a.md still needs re-embedding, so the pruned
		// cache does get persisted on this pass.
		h.vaultFiles.delete('gone.md');
		const next = makeHarness({embeddingCacheEnabled: true});
		next.adapter.files = h.adapter.files;
		next.vaultFiles.set('a.md', makeFile('a.md'));
		await next.addNote('a.md', noteWithChunks(2));
		await next.buildIndex();

		expect(Object.keys(next.adapter.cache('')?.files ?? {})).toEqual(['a.md']);
	});

	// Pre-existing quirk, pinned rather than fixed: loadFolderCache prunes dead entries but does
	// not mark the folder dirty, so a pass with nothing else to do never persists the pruning.
	it('does not persist a pruning-only pass', async () => {
		const h = makeHarness({embeddingCacheEnabled: true});
		const content = noteWithChunks(1);
		await h.addNote('a.md', content);
		await h.buildIndex();

		const next = makeHarness({embeddingCacheEnabled: true});
		next.adapter.files = h.adapter.files;
		// a.md is unchanged (a cache hit), and a stale entry exists for a note that is gone.
		const cache = next.adapter.cache('') ?? {version: CACHE_VERSION, files: {}};
		cache.files['gone.md'] = {key: 'x', chunks: []};
		next.adapter.files.set(cachePathFor(''), JSON.stringify(cache));
		next.adapter.writes.length = 0;
		await next.addNote('a.md', content);

		await next.buildIndex();

		expect(next.adapter.writes).toEqual([]);
		expect(Object.keys(next.adapter.cache('')?.files ?? {})).toContain('gone.md');
	});
});

describe('getRawContext', () => {
	it('prefixes each note with its basename', async () => {
		const h = makeHarness();
		await h.addNote('notes/a.md', 'alpha');

		expect(h.context.getRawContext()).toBe('[a.md]\nalpha');
	});

	it('joins notes with a horizontal rule', async () => {
		const h = makeHarness();
		await h.addNote('a.md', 'alpha');
		await h.addNote('b.md', 'beta');

		expect(h.context.getRawContext()).toBe('[a.md]\nalpha\n\n---\n\n[b.md]\nbeta');
	});

	it('returns an empty string with no context', () => {
		expect(makeHarness().context.getRawContext()).toBe('');
	});
});

describe('getContextNotes', () => {
	it('lists each note by basename, in the order added', async () => {
		const h = makeHarness();
		await h.addNote('notes/a.md', 'alpha');
		await h.addNote('b.md', 'beta');

		expect(h.context.getContextNotes()).toEqual([{name: 'a.md', text: 'alpha'}, {name: 'b.md', text: 'beta'}]);
	});

	it('is empty with no context', () => {
		expect(makeHarness().context.getContextNotes()).toEqual([]);
	});
});

describe('getRelevantContext', () => {
	const oneHot = (position: number, length: number) =>
		Array.from({length}, (_, i) => (i === position ? 1 : 0));

	it('returns an empty string when the index is empty', () => {
		expect(makeHarness().context.getRelevantContext([1, 0], 3)).toBe('');
	});

	it('prepends the RAG template exactly once', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(3));
		await h.buildIndex();

		const output = h.context.getRelevantContext(oneHot(0, 3), 3);

		expect(output.startsWith(RAG_CONTEXT_TEMPLATE)).toBe(true);
		expect(output.split(RAG_CONTEXT_TEMPLATE)).toHaveLength(2);
	});

	it('joins the retrieved chunks with a horizontal rule', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		await h.buildIndex();

		const body = h.context.getRelevantContext(oneHot(0, 2), 2).slice(RAG_CONTEXT_TEMPLATE.length);

		expect(body.split('\n\n---\n\n')).toHaveLength(2);
	});

	it('honours topK', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(4));
		await h.buildIndex();

		const body = h.context.getRelevantContext(oneHot(0, 4), 1).slice(RAG_CONTEXT_TEMPLATE.length);

		expect(body.split('\n\n---\n\n')).toHaveLength(1);
	});

	it('ranks the chunk matching the query first', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(3));
		await h.buildIndex();
		const requested = h.ai.getEmbeddings.mock.calls[0][0] as string[];

		const body = h.context.getRelevantContext(oneHot(2, 3), 1).slice(RAG_CONTEXT_TEMPLATE.length);

		expect(body).toBe(requested[2]);
	});

	// The window is shared with the question and the conversation, so excerpts get a share of it.
	describe('within a size', () => {
		const SEP = '\n\n---\n\n';
		const excerpts = (output: string) => output.slice(RAG_CONTEXT_TEMPLATE.length).split(SEP);

		it('drops the lowest-ranked excerpts to fit', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(3));
			await h.buildIndex();
			const all = excerpts(h.context.getRelevantContext(oneHot(0, 3), 3));
			const cap = RAG_CONTEXT_TEMPLATE.length + all[0].length + SEP.length + all[1].length;

			const output = h.context.getRelevantContext(oneHot(0, 3), 3, cap);

			expect(output).toBe(RAG_CONTEXT_TEMPLATE + all[0] + SEP + all[1]);
		});

		// Linked notes are a bonus; the search results are what the question matched.
		it('drops linked-note excerpts before search results', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.addNote('linked.md', noteWithChunks(1));
			await h.buildIndex();
			h.links.set('a.md', [{link: 'linked.md'}]);
			const [result] = excerpts(h.context.getRelevantContext(oneHot(0, 2), 1));

			const output = h.context.getRelevantContext(oneHot(0, 2), 1, RAG_CONTEXT_TEMPLATE.length + result.length);

			expect(output).toBe(RAG_CONTEXT_TEMPLATE + result);
		});

		it('keeps the best excerpt even when it alone is too long', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(3));
			await h.buildIndex();
			const [best] = excerpts(h.context.getRelevantContext(oneHot(0, 3), 3));

			expect(h.context.getRelevantContext(oneHot(0, 3), 3, 10)).toBe(RAG_CONTEXT_TEMPLATE + best);
		});

		it('leaves everything when it all fits', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(3));
			await h.buildIndex();
			const all = h.context.getRelevantContext(oneHot(0, 3), 3);

			expect(h.context.getRelevantContext(oneHot(0, 3), 3, 1_000_000)).toBe(all);
		});
	});

	describe('graph expansion', () => {
		it('pulls in chunks from notes the results link out to', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.addNote('linked.md', noteWithChunks(1));
			await h.buildIndex();
			h.links.set('a.md', [{link: 'linked.md'}]);

			// topK 1 would return only a.md's chunk; expansion adds the linked note's.
			const output = h.context.getRelevantContext(oneHot(0, 2), 1);

			expect(output).toContain('Section 0');
			expect(output.slice(RAG_CONTEXT_TEMPLATE.length).split('\n\n---\n\n')).toHaveLength(2);
		});

		it('pulls in backlinks', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.addNote('source.md', noteWithChunks(1));
			await h.buildIndex();
			h.resolvedLinks['source.md'] = {'a.md': 1};

			const body = h.context.getRelevantContext(oneHot(0, 2), 1).slice(RAG_CONTEXT_TEMPLATE.length);

			expect(body.split('\n\n---\n\n')).toHaveLength(2);
		});

		it('does not duplicate a note already among the results', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.addNote('b.md', noteWithChunks(1));
			await h.buildIndex();
			// a and b link to each other, and both are already retrieved at topK 2.
			h.links.set('a.md', [{link: 'b.md'}]);
			h.links.set('b.md', [{link: 'a.md'}]);

			const body = h.context.getRelevantContext(oneHot(0, 2), 2).slice(RAG_CONTEXT_TEMPLATE.length);

			expect(body.split('\n\n---\n\n')).toHaveLength(2);
		});

		it('still prepends the template exactly once on the expansion path', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.addNote('linked.md', noteWithChunks(1));
			await h.buildIndex();
			h.links.set('a.md', [{link: 'linked.md'}]);

			const output = h.context.getRelevantContext(oneHot(0, 2), 1);

			expect(output.split(RAG_CONTEXT_TEMPLATE)).toHaveLength(2);
		});

		it('ignores a link that does not resolve', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.buildIndex();
			h.links.set('a.md', [{link: 'nonexistent.md'}]);

			const body = h.context.getRelevantContext(oneHot(0, 1), 1).slice(RAG_CONTEXT_TEMPLATE.length);

			expect(body.split('\n\n---\n\n')).toHaveLength(1);
		});

		it('skips expansion when the retrieved note is not in the vault', async () => {
			const h = makeHarness();
			await h.addNote('a.md', noteWithChunks(1));
			await h.buildIndex();
			h.vaultFiles.delete('a.md');

			expect(h.context.getRelevantContext(oneHot(0, 1), 1)).toContain('Section 0');
		});
	});
});

describe('embedding dimensions', () => {
	// VectorIndex scores a size mismatch as 0 rather than throwing, so without this guard mixed
	// sizes would quietly retrieve nothing relevant, with no error anywhere.
	it('refuses vectors of different sizes within one build', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(2));
		h.ai.getEmbeddings.mockResolvedValueOnce([[1, 0], [1, 0, 0]]);

		await expect(h.buildIndex()).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
		// A half-built index of mixed sizes would retrieve garbage, so none is left behind.
		expect(h.context.hasIndex()).toBe(false);
	});

	/**
	 * The llama.cpp case: the embedding server was restarted on a different model under the same
	 * name and port, so the cache key still matches while the vectors no longer do.
	 */
	const staleCacheScenario = async () => {
		const first = makeHarness({embeddingCacheEnabled: true});
		await first.addNote('a.md', noteWithChunks(1));
		first.ai.getEmbeddings.mockResolvedValueOnce([[1, 0]]);
		await first.buildIndex();

		const next = makeHarness({embeddingCacheEnabled: true});
		next.adapter.files = first.adapter.files;
		await next.addNote('a.md', noteWithChunks(1));
		await next.addNote('b.md', noteWithChunks(1));
		next.ai.getEmbeddings.mockResolvedValueOnce([[1, 0, 0]]);
		return next;
	};

	it('refuses fresh vectors that do not match cached ones', async () => {
		const next = await staleCacheScenario();

		await expect(next.buildIndex()).rejects.toMatchObject({expected: 2, received: 3});
		expect(next.context.hasIndex()).toBe(false);
	});

	// Otherwise a rebuild would reuse the stale vectors and fail the same way forever.
	it('clears the cache on a mismatch, so the next build re-embeds everything', async () => {
		const next = await staleCacheScenario();
		await expect(next.buildIndex()).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
		next.ai.getEmbeddings.mockClear();

		await next.buildIndex();

		expect(next.ai.getEmbeddings).toHaveBeenCalledTimes(1);
		expect(next.ai.getEmbeddings.mock.calls[0][0]).toHaveLength(2);
		expect(next.context.hasIndex()).toBe(true);
	});

	it('accepts a build whose vectors all agree', async () => {
		const h = makeHarness();
		await h.addNote('a.md', noteWithChunks(3));

		await expect(h.buildIndex()).resolves.toBeUndefined();
		expect(h.indexedChunks()).toHaveLength(3);
	});
});
