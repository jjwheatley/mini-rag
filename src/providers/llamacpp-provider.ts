import {OpenAiCompatibleProvider} from "./openai-compatible-provider";
import {ProviderError} from "./errors";
import {getJson} from "./http";
import {trimSlash} from "../settings";
import {ModelInstallHint, ProviderCapabilities, ProviderId} from "./types";

/** Where the setup hint suggests running the second, embedding-only llama-server. */
const EMBEDDING_SERVER_URL = 'http://localhost:8081';
const EMBEDDING_SERVER_PORT = '8081';
const CHAT_SERVER_PORT = '8080';

/** The chat model the setup hint suggests: small enough to download quickly and run on most GPUs. */
const EXAMPLE_CHAT_MODEL = 'bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M';

/**
 * The port llama-server has to listen on for Mini-RAG to find it at `url`: the URL's own, or its
 * scheme's. An address that cannot be read suggests the usual port, `fallback`.
 */
function listenPort(url: string, fallback: string): string {
	try {
		const {port, protocol} = new URL(url);
		if (protocol === 'http:') return port || '80';
		if (protocol === 'https:') return port || '443';
	} catch {
		// Not a URL at all.
	}
	return fallback;
}

/** A Hugging Face id ("owner/repo", optionally ":quant"), which only -hf can start. */
const HF_MODEL_ID = /^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/;

/**
 * The embedders Ollama suggests, as GGUF builds on Hugging Face that `llama-server -hf` can fetch.
 * Q8_0 throughout: embedding models are small, so there is little to gain from squeezing them.
 */
const CURATED_EMBEDDING_MODELS: readonly {id: string; name: string}[] = [
	// Each goes by the name Ollama gives the same model, so the two lists read alike.
	{id: 'second-state/All-MiniLM-L6-v2-Embedding-GGUF:Q8_0', name: 'all-minilm'},
	{id: 'ggml-org/bge-m3-Q8_0-GGUF', name: 'bge-m3'},
	{id: 'ChristianAzinn/mxbai-embed-large-v1-gguf:Q8_0', name: 'mxbai-embed-large'},
	{id: 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0', name: 'nomic-embed-text'},
	{id: 'mradermacher/snowflake-arctic-embed-l-GGUF:Q8_0', name: 'snowflake-arctic-embed'},
];

/** A Hugging Face id's ":Q8_0" is how the model was quantised, not which model it is. */
const modelIdentity = (id: string) => (HF_MODEL_ID.test(id) ? id.split(':')[0] : id).toLowerCase();

/** Quantisation tags that GGUF filenames commonly end in: -Q4_K_M, .Q8_0, -IQ4_XS, -F16 ... */
const QUANT_SUFFIX = /[-.](?:I?Q\d\w*|F16|F32|BF16)$/i;

/**
 * llama.cpp's llama-server. It serves exactly one model per process, which shapes everything
 * here: the model "list" is that one model, and a dedicated embedding model needs a second
 * server on its own port — hence the separate embedding endpoint.
 */
export class LlamaCppProvider extends OpenAiCompatibleProvider {
	readonly id: ProviderId = 'llamacpp';

	readonly capabilities: ProviderCapabilities = {
		displayName: 'llama.cpp',
		embeddings: true,
		dedicatedEmbeddingModel: true,
		separateEmbeddingEndpoint: true,
		modelListing: true,
		// The same well-known embedders as Ollama, matched against what the embedding server runs.
		embeddingModelSelection: 'curated',
		modelUnloadPolling: false,
		modelIdsHaveTags: false,
		// llama-server answers with the model it was started with, whatever a request names.
		modelFixedByServer: true,
	};

	/** The chat server's model, as it last reported it; null until it has, or if it is down. */
	runningChatModel: string | null = null;

	/** The embedding server's model, likewise. */
	private runningEmbeddingModel: string | null = null;

	async getModelList(): Promise<string[]> {
		try {
			const models = await this.modelsAt(this.baseUrl);
			this.runningChatModel = models.length === 1 ? models[0] : null;
			return models;
		} catch (error) {
			this.runningChatModel = null;
			throw error;
		}
	}

	/**
	 * The model the second, embedding server is running. With no second server configured, the
	 * only model running is the chat model — not an embedder — so there is nothing to offer.
	 * Listed whether or not the dedicated model is on yet, so switching it on can pick this one.
	 */
	async listEmbeddingModels(): Promise<string[]> {
		this.runningEmbeddingModel = null;
		if (!this.config.embeddingUrl) return [];
		const models = await this.modelsAt(trimSlash(this.config.embeddingUrl));
		this.runningEmbeddingModel = models.length === 1 ? models[0] : null;
		return models;
	}

	/**
	 * llama-server ignores the model a request names, so what each server runs is the model in
	 * use: it is what an index is keyed on and what a chat is named. Asked before each index build.
	 */
	async identifyRunningModels(): Promise<void> {
		await Promise.all([
			this.getModelList().catch(() => undefined),
			this.listEmbeddingModels().catch(() => undefined),
		]);
	}

	/** The model embeddings really come from: what the server runs, once it has said. */
	get resolvedEmbeddingModel(): string {
		const config = this.config;
		if (config.dedicatedEmbeddingEnabled && (this.runningEmbeddingModel || config.embeddingModel)) {
			return this.runningEmbeddingModel ?? config.embeddingModel;
		}
		return this.runningChatModel ?? config.chatModel;
	}

	/**
	 * Prefers /v1/models, and falls back to /props — which every llama-server build has exposed —
	 * only when the former does not exist. Any other failure is real and is not masked: a 503
	 * means the model is still loading, and an unreachable server is unreachable either way.
	 */
	private async modelsAt(base: string): Promise<string[]> {
		try {
			return await this.listModelsAt(base);
		} catch (error) {
			if (!(error instanceof ProviderError && error.status === 404)) throw error;
			return this.modelFromProps(base);
		}
	}

	private async modelFromProps(base: string): Promise<string[]> {
		const result = await getJson({url: `${base}/props`});
		if (result.status >= 400) {
			throw this.requestError(result.status, result.text, result.json);
		}
		// Newer builds report model_path at the top level; older ones nest it.
		const path = result.json?.model_path ?? result.json?.default_generation_settings?.model;
		return typeof path === 'string' && path ? [path] : [];
	}

	/** The window llama-server was started with (-c), which it refuses to exceed. */
	async contextLength(): Promise<number | null> {
		try {
			const result = await getJson({url: `${this.baseUrl}/props`});
			const size = result.status < 400 ? result.json?.default_generation_settings?.n_ctx : undefined;
			return typeof size === 'number' && size > 0 ? size : null;
		} catch {
			return null;
		}
	}

	curatedEmbeddingModels(): string[] {
		return CURATED_EMBEDDING_MODELS.map(model => model.id);
	}

	isSameModel(a: string, b: string): boolean {
		return modelIdentity(a) === modelIdentity(b);
	}

	/** Model ids are file paths; headers and saved-chat filenames want the model's name. */
	displayModelName(id: string): string {
		const curated = CURATED_EMBEDDING_MODELS.find(model => this.isSameModel(model.id, id));
		if (curated) return curated.name;
		const filename = id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\')) + 1);
		return filename
			// A Hugging Face id's ":Q8_0" tag, and the "-GGUF" its repository names carry.
			.replace(/:[^:]*$/, '')
			.replace(/[.-]gguf$/i, '')
			.replace(QUANT_SUFFIX, '');
	}

	/** The fixes are launch flags, since llama-server is configured on its command line. */
	protected gpuTroubleshooting() {
		return {
			server: 'llama-server',
			tips: [
				'Offload fewer layers to the GPU: restart llama-server with a lower -ngl (or -ngl 0 to run on the CPU)',
				'Load the model with a smaller context: lower -c',
				'Choose a smaller or more heavily quantised model',
			],
		};
	}

	embeddingInstallHint(model: string): ModelInstallHint {
		const file = model || 'embedding-model.gguf';
		const flag = HF_MODEL_ID.test(file) && !/\.gguf$/i.test(file) ? '-hf' : '-m';
		// The command must start the server where Mini-RAG will look for it.
		const serverUrl = this.config.embeddingUrl.trim() || EMBEDDING_SERVER_URL;
		const port = listenPort(serverUrl, EMBEDDING_SERVER_PORT);
		return {
			summary: model
				? `Mini-RAG expected to find "${this.displayModelName(model)}" running on port ${port}.`
				: `Mini-RAG expected to find an embedding model running on port ${port}.`,
			command: `llama-server ${flag} ${file} --embeddings --port ${port}`,
			// llama-server keeps running, so it must not take over a terminal that is in use.
			commandNote: 'in a separate terminal to any others',
		};
	}

	/**
	 * llama-server runs one model per process, so the model list never has another to switch to:
	 * a different model means restarting the server with it, where Mini-RAG will look for it.
	 */
	chatModelInstallHint(): ModelInstallHint {
		const port = listenPort(this.config.url, CHAT_SERVER_PORT);
		return {
			summary: 'llama-server runs one model at a time. To use another, restart it with that model, for example:',
			command: `llama-server -hf ${EXAMPLE_CHAT_MODEL} -ngl 99 -c 8192 --port ${port}`,
		};
	}
}
