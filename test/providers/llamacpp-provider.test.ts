import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetRequestUrl, __setRequestUrlHandler, requestUrlCalls, RequestUrlParam} from '../stubs/obsidian';
import {LlamaCppProvider} from '../../src/providers/llamacpp-provider';
import {OpenAiCompatibleProvider} from '../../src/providers/openai-compatible-provider';
import {ProviderError, ProviderUnreachableError} from '../../src/providers/errors';
import {defaultSettings} from '../../src/defaults';
import {PluginSettings, ProviderConfig} from '../../src/types';

const URL_BASE = 'http://localhost:8080';
const NOMIC_ID = 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0';

function makeProvider(config: Partial<ProviderConfig> = {}) {
	const settings: PluginSettings = defaultSettings();
	settings.provider = 'llamacpp';
	Object.assign(settings.providers.llamacpp, config);
	return new LlamaCppProvider({settings});
}

/** Routes by URL suffix, so one handler serves a test touching several endpoints. */
function routeByPath(routes: Record<string, (request: RequestUrlParam) => unknown>) {
	__setRequestUrlHandler(request => {
		for (const [suffix, respond] of Object.entries(routes)) {
			if (request.url.endsWith(suffix)) return respond(request) as never;
		}
		throw new Error(`unrouted request: ${request.url}`);
	});
}

beforeEach(() => {
	__resetRequestUrl();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('identity', () => {
	it('speaks the OpenAI-compatible wire format', () => {
		expect(makeProvider()).toBeInstanceOf(OpenAiCompatibleProvider);
	});

	it('identifies as llamacpp', () => {
		expect(makeProvider().id).toBe('llamacpp');
	});

	it('declares the llama-server feature set', () => {
		expect(makeProvider().capabilities).toEqual({
			displayName: 'llama.cpp',
			embeddings: true,
			dedicatedEmbeddingModel: true,
			// One model per process: a dedicated embedding model means a second instance.
			separateEmbeddingEndpoint: true,
			modelListing: true,
			// The same well-known embedders as Ollama, as Hugging Face GGUF builds, matched against
			// the model the embedding server reports.
			embeddingModelSelection: 'curated',
			modelUnloadPolling: false,
			modelIdsHaveTags: false,
			// llama-server runs the model it was started with, whatever a request names.
			modelFixedByServer: true,
		});
	});

	it('defaults to llama-server\'s port', () => {
		expect(defaultSettings().providers.llamacpp.url).toBe(URL_BASE);
	});

	it('has no VRAM unload to wait for', async () => {
		expect(await makeProvider().waitForEmbeddingModelUnloaded()).toBe(true);
		expect(requestUrlCalls).toEqual([]);
	});
});

describe('getModelList', () => {
	// A refused connection fails the same way every time — and on Windows takes two seconds to
	// do so — so retrying only keeps the settings tab waiting. The refresh button is there.
	it('gives up at once when nothing is listening', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		await expect(makeProvider().getModelList()).rejects.toBeInstanceOf(ProviderUnreachableError);
		expect(requestUrlCalls).toHaveLength(1);
	});

	it('still retries a server that answers with an error', async () => {
		vi.useFakeTimers();
		let attempt = 0;
		routeByPath({'/v1/models': () => (++attempt < 2 ? {status: 503, text: 'Loading model'} : {json: {data: [{id: 'm'}]}})});

		const result = makeProvider().getModelList();
		await vi.advanceTimersByTimeAsync(2000);

		expect(await result).toEqual(['m']);
	});

	// llama-server reports the single model it was started with.
	it('reports the loaded model from /v1/models', async () => {
		routeByPath({'/v1/models': () => ({json: {data: [{id: '/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf'}]}})});

		expect(await makeProvider().getModelList()).toEqual(['/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf']);
		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/v1/models`);
	});

	// Older builds lack /v1/models but have always exposed /props.
	it('falls back to /props when /v1/models is missing', async () => {
		routeByPath({
			'/v1/models': () => ({status: 404, text: 'Not Found'}),
			'/props': () => ({json: {model_path: '/models/mistral-7b.Q8_0.gguf'}}),
		});

		expect(await makeProvider().getModelList()).toEqual(['/models/mistral-7b.Q8_0.gguf']);
		expect(requestUrlCalls.map(c => c.url)).toEqual([`${URL_BASE}/v1/models`, `${URL_BASE}/props`]);
	});

	it('reads the older /props shape', async () => {
		routeByPath({
			'/v1/models': () => ({status: 404, text: 'Not Found'}),
			'/props': () => ({json: {default_generation_settings: {model: '/models/old.gguf'}}}),
		});

		expect(await makeProvider().getModelList()).toEqual(['/models/old.gguf']);
	});

	it('returns an empty list when /props names no model', async () => {
		routeByPath({
			'/v1/models': () => ({status: 404, text: 'Not Found'}),
			'/props': () => ({json: {}}),
		});

		expect(await makeProvider().getModelList()).toEqual([]);
	});

	// A 503 means "still loading"; falling back to /props would only mask it.
	it('does not fall back on a server error', async () => {
		vi.useFakeTimers();
		routeByPath({'/v1/models': () => ({status: 503, text: 'Loading model'})});

		const assertion = expect(makeProvider().getModelList()).rejects.toMatchObject({status: 503});
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(requestUrlCalls.every(c => c.url.endsWith('/v1/models'))).toBe(true);
	});

	it('does not fall back when the server is unreachable', async () => {
		vi.useFakeTimers();
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		const assertion = expect(makeProvider().getModelList()).rejects.toBeInstanceOf(ProviderUnreachableError);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(requestUrlCalls.some(c => c.url.endsWith('/props'))).toBe(false);
	});

	it('raises a failing /props', async () => {
		routeByPath({
			'/v1/models': () => ({status: 404, text: 'Not Found'}),
			'/props': () => ({status: 404, text: 'Not Found'}),
		});

		await expect(makeProvider().getModelList()).rejects.toMatchObject({status: 404});
	});
});

describe('contextLength', () => {
	// llama-server refuses an over-long request outright, so Mini-RAG needs the limit up front.
	it('reads the context size the server was started with', async () => {
		routeByPath({'/props': () => ({json: {default_generation_settings: {n_ctx: 8192}}})});

		expect(await makeProvider().contextLength()).toBe(8192);
		expect(requestUrlCalls.map(c => c.url)).toEqual([`${URL_BASE}/props`]);
	});

	it('asks the chat server, not the embedding server', async () => {
		routeByPath({'/props': () => ({json: {default_generation_settings: {n_ctx: 4096}}})});

		await makeProvider({embeddingUrl: 'http://localhost:8081', dedicatedEmbeddingEnabled: true}).contextLength();

		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/props`);
	});

	// An unknown size means "send it all and let the server decide", as before.
	it.each([
		['the size is missing', () => ({json: {default_generation_settings: {}}})],
		['the size is not a number', () => ({json: {default_generation_settings: {n_ctx: 'big'}}})],
		['the server errors', () => ({status: 500, text: 'oops'})],
	])('is unknown when %s', async (_case, respond) => {
		routeByPath({'/props': respond});

		expect(await makeProvider().contextLength()).toBeNull();
	});

	it('is unknown when the server is unreachable', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		expect(await makeProvider().contextLength()).toBeNull();
		// A best-effort lookup: no retries delaying the message.
		expect(requestUrlCalls).toHaveLength(1);
	});
});

// llama-server ignores the model a request names and answers with the one it runs, so the
// running models are the ones in use: they are what is named, and what the cache is keyed on.
describe('the models the servers run', () => {
	const QWEN = 'bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M';
	const NOMIC = 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0';
	const bothServers = () => routeByPath({
		':8080/v1/models': () => ({json: {data: [{id: QWEN}]}}),
		':8081/v1/models': () => ({json: {data: [{id: NOMIC}]}}),
	});
	const dedicated = (embeddingModel: string) =>
		makeProvider({embeddingUrl: 'http://localhost:8081', dedicatedEmbeddingEnabled: true, embeddingModel});

	it('notes the chat model when it lists the chat server\'s models', async () => {
		bothServers();
		const provider = makeProvider();

		await provider.getModelList();

		expect(provider.runningChatModel).toBe(QWEN);
	});

	it('forgets it when the chat server cannot be reached', async () => {
		bothServers();
		const provider = makeProvider();
		await provider.getModelList();
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		await expect(provider.getModelList()).rejects.toThrow();

		expect(provider.runningChatModel).toBeNull();
	});

	it('embeds as the model the embedding server runs, whatever was chosen', async () => {
		bothServers();
		const provider = dedicated('ggml-org/bge-m3-Q8_0-GGUF');

		await provider.listEmbeddingModels();

		expect(provider.resolvedEmbeddingModel).toBe(NOMIC);
	});

	it('goes by the chosen name until a server has said', () => {
		expect(dedicated('ggml-org/bge-m3-Q8_0-GGUF').resolvedEmbeddingModel).toBe('ggml-org/bge-m3-Q8_0-GGUF');
	});

	it('forgets the embedding model when the embedding server cannot be reached', async () => {
		bothServers();
		const provider = dedicated('ggml-org/bge-m3-Q8_0-GGUF');
		await provider.listEmbeddingModels();
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		await expect(provider.listEmbeddingModels()).rejects.toThrow();

		expect(provider.resolvedEmbeddingModel).toBe('ggml-org/bge-m3-Q8_0-GGUF');
	});

	// Without a dedicated model, the chat server embeds, as whatever it runs.
	it('embeds as the running chat model when there is no dedicated one', async () => {
		bothServers();
		const provider = makeProvider({chatModel: 'old-choice.gguf', dedicatedEmbeddingEnabled: false});

		await provider.getModelList();

		expect(provider.resolvedEmbeddingModel).toBe(QWEN);
	});

	it('asks both servers in one go', async () => {
		bothServers();
		const provider = dedicated('ggml-org/bge-m3-Q8_0-GGUF');

		await provider.identifyRunningModels();

		expect(provider.runningChatModel).toBe(QWEN);
		expect(provider.resolvedEmbeddingModel).toBe(NOMIC);
	});

	// Called before every index build; a server that is down must not stop it here.
	it('never throws when asking', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		await expect(dedicated('x').identifyRunningModels()).resolves.toBeUndefined();
	});
});

describe('listEmbeddingModels', () => {
	const EMBEDDING_BASE = 'http://localhost:8081';

	// The second llama-server reports its one model, just as the chat server does.
	// Listed even while the dedicated model is off, so switching it on can pick the model at once.
	it('reports the model the embedding server was started with', async () => {
		routeByPath({'/v1/models': () => ({json: {data: [{id: 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0'}]}})});

		const models = await makeProvider({embeddingUrl: EMBEDDING_BASE}).listEmbeddingModels();

		expect(models).toEqual(['nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0']);
		expect(requestUrlCalls.map(c => c.url)).toEqual([`${EMBEDDING_BASE}/v1/models`]);
	});

	it('falls back to the embedding server\'s /props', async () => {
		routeByPath({
			'/v1/models': () => ({status: 404, text: 'Not Found'}),
			'/props': () => ({json: {model_path: '/models/nomic-embed.gguf'}}),
		});

		const models = await makeProvider({embeddingUrl: EMBEDDING_BASE}).listEmbeddingModels();

		expect(models).toEqual(['/models/nomic-embed.gguf']);
		expect(requestUrlCalls.map(c => c.url)).toEqual([
			`${EMBEDDING_BASE}/v1/models`,
			`${EMBEDDING_BASE}/props`,
		]);
	});

	// Without a second server, the only model running is the chat model, which is not an embedder.
	it('offers nothing, without asking, when no embedding server is set', async () => {
		expect(await makeProvider({embeddingUrl: ''}).listEmbeddingModels()).toEqual([]);
		expect(requestUrlCalls).toEqual([]);
	});

	it('raises an unreachable embedding server, without retrying', async () => {
		__setRequestUrlHandler(() => {
			throw new Error('ECONNREFUSED');
		});

		await expect(makeProvider({embeddingUrl: EMBEDDING_BASE}).listEmbeddingModels())
			.rejects.toBeInstanceOf(ProviderUnreachableError);
		expect(requestUrlCalls).toHaveLength(1);
	});
});

describe('curatedEmbeddingModels', () => {
	// The models Ollama suggests, as GGUF builds llama-server can fetch with -hf.
	it('offers the same embedders as Ollama, as Hugging Face builds', () => {
		expect(makeProvider().curatedEmbeddingModels()).toEqual([
			'second-state/All-MiniLM-L6-v2-Embedding-GGUF:Q8_0',
			'ggml-org/bge-m3-Q8_0-GGUF',
			'ChristianAzinn/mxbai-embed-large-v1-gguf:Q8_0',
			'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0',
			'mradermacher/snowflake-arctic-embed-l-GGUF:Q8_0',
		]);
	});

	it('starts each with -hf', () => {
		const provider = makeProvider();

		for (const model of provider.curatedEmbeddingModels()) {
			expect(provider.embeddingInstallHint(model).command).toBe(
				`llama-server -hf ${model} --embeddings --port 8081`,
			);
		}
	});

	it('returns a copy', () => {
		const provider = makeProvider();
		provider.curatedEmbeddingModels().push('injected');

		expect(provider.curatedEmbeddingModels()).not.toContain('injected');
	});
});

describe('isSameModel', () => {
	// The quantisation is how the model was built, not which model it is.
	it('ignores the quantisation tag and case', () => {
		expect(makeProvider().isSameModel(
			'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0',
			'nomic-ai/nomic-embed-text-v1.5-gguf:q4_k_m',
		)).toBe(true);
	});

	it('matches an id with no tag', () => {
		expect(makeProvider().isSameModel('ggml-org/bge-m3-Q8_0-GGUF', 'ggml-org/bge-m3-Q8_0-GGUF:Q8_0')).toBe(true);
	});

	it('tells different models apart', () => {
		expect(makeProvider().isSameModel('ggml-org/bge-m3-Q8_0-GGUF', NOMIC_ID)).toBe(false);
	});

	// A Windows path's drive letter is not a tag.
	it('compares file paths whole', () => {
		expect(makeProvider().isSameModel('C:\\models\\a.gguf', 'C:\\models\\b.gguf')).toBe(false);
	});
});

describe('displayModelName', () => {
	// Model ids are file paths; headers and saved-chat filenames want something readable.
	it.each([
		['/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf', 'Llama-3.2-3B-Instruct'],
		['C:\\models\\mistral-7b.Q8_0.gguf', 'mistral-7b'],
		['/models/phi-3-mini-F16.gguf', 'phi-3-mini'],
		['/models/gemma-2b-it-IQ4_XS.gguf', 'gemma-2b-it'],
		['/models/plain.gguf', 'plain'],
		['qwen2.5-7b-instruct', 'qwen2.5-7b-instruct'],
		// Hugging Face ids, as llama-server -hf reports them.
		['bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', 'Qwen2.5-7B-Instruct'],
		['leliuga/all-MiniLM-L6-v2-GGUF:Q8_0', 'all-MiniLM-L6-v2'],
		['mradermacher/snowflake-arctic-embed-m-GGUF:Q8_0', 'snowflake-arctic-embed-m'],
		['cstr/mxbai-embed-large-v1-GGUF', 'mxbai-embed-large-v1'],
		// The curated embedders go by the names Ollama gives the same models.
		['second-state/All-MiniLM-L6-v2-Embedding-GGUF:Q8_0', 'all-minilm'],
		['ggml-org/bge-m3-Q8_0-GGUF', 'bge-m3'],
		['ChristianAzinn/mxbai-embed-large-v1-gguf:Q8_0', 'mxbai-embed-large'],
		['nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0', 'nomic-embed-text'],
		['mradermacher/snowflake-arctic-embed-l-GGUF:Q8_0', 'snowflake-arctic-embed'],
		// Whatever quantisation the server was started with.
		['nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M', 'nomic-embed-text'],
		['', ''],
	])('displays %s as %s', (id, expected) => {
		expect(makeProvider().displayModelName(id)).toBe(expected);
	});
});

// llama-server runs one model per process, so its model list never offers anything to switch to:
// the way to another model is restarting the server with it.
describe('chatModelInstallHint', () => {
	it('shows how to start the server with a small model', () => {
		const hint = makeProvider().chatModelInstallHint();

		expect(hint.summary).toMatch(/one model at a time/);
		expect(hint.command).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080');
	});

	// The command has to start the server where Mini-RAG will look for it.
	it('uses the port of the configured URL', () => {
		expect(makeProvider({url: 'http://localhost:9000'}).chatModelInstallHint().command).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 9000');
	});

	it('suggests port 8080 when the URL cannot be read', () => {
		expect(makeProvider({url: 'not a url'}).chatModelInstallHint().command).toBe('llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080');
	});
});

describe('embeddingInstallHint', () => {
	it('says which model it expected, and on which port', () => {
		const hint = makeProvider().embeddingInstallHint(NOMIC_ID);

		expect(hint.summary).toBe('Mini-RAG expected to find "nomic-embed-text" running on port 8081.');
		expect(hint.command).toBe(`llama-server -hf ${NOMIC_ID} --embeddings --port 8081`);
	});

	// llama-server keeps running, so it needs a terminal of its own.
	it('says to run it in a terminal of its own', () => {
		expect(makeProvider().embeddingInstallHint(NOMIC_ID).commandNote).toBe('in a separate terminal to any others');
	});

	it('starts a model file with -m', () => {
		expect(makeProvider().embeddingInstallHint('nomic-embed-text-v1.5.f16.gguf').command)
			.toBe('llama-server -m nomic-embed-text-v1.5.f16.gguf --embeddings --port 8081');
	});

	// Ids like "owner/repo:quant" come from starting llama-server with -hf, and only -hf takes them.
	it('names the model readably, keeping the full id in the command', () => {
		const hint = makeProvider().embeddingInstallHint(NOMIC_ID);

		expect(hint.summary).toContain('"nomic-embed-text"');
		expect(hint.command).toContain(NOMIC_ID);
	});

	it('starts a Hugging Face model with -hf', () => {
		expect(makeProvider().embeddingInstallHint('nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0').command).toBe(
			'llama-server -hf nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0 --embeddings --port 8081',
		);
	});

	it.each(['/models/nomic.gguf', 'C:\\models\\nomic.gguf', 'models/nomic.gguf'])('starts a model file %s with -m', model => {
		expect(makeProvider().embeddingInstallHint(model).command).toBe(
			`llama-server -m ${model} --embeddings --port 8081`,
		);
	});

	// The command has to start the server where Mini-RAG will look for it.
	it('starts the server on the port of the configured embedding server', () => {
		const hint = makeProvider({embeddingUrl: 'http://localhost:8082'}).embeddingInstallHint(NOMIC_ID);

		expect(hint.command).toBe(`llama-server -hf ${NOMIC_ID} --embeddings --port 8082`);
		expect(hint.summary).toContain('port 8082');
	});

	it('uses the scheme\'s port when the URL names none', () => {
		expect(makeProvider({embeddingUrl: 'http://localhost'}).embeddingInstallHint(NOMIC_ID).command)
			.toMatch(/--port 80$/);
		expect(makeProvider({embeddingUrl: 'https://embed.local'}).embeddingInstallHint(NOMIC_ID).command)
			.toMatch(/--port 443$/);
	});

	it.each(['', 'htpps:', 'not a url'])('suggests port 8081 when the URL is %j', embeddingUrl => {
		expect(makeProvider({embeddingUrl}).embeddingInstallHint(NOMIC_ID).command).toMatch(/--port 8081$/);
	});

	it('expects an embedding model when none is named', () => {
		expect(makeProvider().embeddingInstallHint('').summary)
			.toBe('Mini-RAG expected to find an embedding model running on port 8081.');
	});

	it('uses a placeholder when no embedding model is named', () => {
		expect(makeProvider().embeddingInstallHint('').command).toBe(
			'llama-server -m embedding-model.gguf --embeddings --port 8081',
		);
	});
});

describe('embeddings', () => {
	it('go to the dedicated embedding server when one is configured', async () => {
		routeByPath({'/v1/embeddings': () => ({json: {data: [{index: 0, embedding: [1]}]}})});
		const provider = makeProvider({embeddingUrl: 'http://localhost:8081', dedicatedEmbeddingEnabled: true});

		await provider.getEmbeddings(['a']);

		expect(requestUrlCalls[0].url).toBe('http://localhost:8081/v1/embeddings');
	});

	it('go to the chat server while the dedicated model is off', async () => {
		routeByPath({'/v1/embeddings': () => ({json: {data: [{index: 0, embedding: [1]}]}})});
		const provider = makeProvider({embeddingUrl: 'http://localhost:8081', dedicatedEmbeddingEnabled: false});

		await provider.getEmbeddings(['a']);

		expect(requestUrlCalls[0].url).toBe(`${URL_BASE}/v1/embeddings`);
	});
});

describe('formatError', () => {
	const format = (message: string) =>
		makeProvider().formatError(new ProviderError(`llama.cpp request failed (500): ${message}`, {detail: message}));

	// GPU failures are the commonest llama-server error, and the fix is a launch flag the user
	// controls -- so say which one, rather than echoing the raw ggml message.
	it.each([
		'CUDA error: out of memory',
		'ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected',
		'failed to allocate compute buffer',
		'vk::DeviceLostError (Vulkan)',
	])('offers llama-server GPU advice for "%s"', message => {
		const text = format(message);

		expect(text).toMatch(/could not run the model on your GPU/);
		expect(text).toContain('-ngl');
		expect(text).toContain('-c');
		expect(text).toContain(`Details: ${message}`);
	});

	// Ollama's advice (OLLAMA_NO_GPU, restart the Ollama app) would send the user the wrong way.
	it('does not give Ollama\'s advice', () => {
		expect(format('CUDA error: out of memory')).not.toMatch(/ollama/i);
	});

	it('recognises a GPU failure in a plain error too', () => {
		expect(makeProvider().formatError(new Error('CUDA error: out of memory'))).toContain('-ngl');
	});

	it('passes any other error through as the server described it', () => {
		expect(format('model file not found')).toBe('model file not found');
	});
});
