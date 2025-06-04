import {PluginSettings} from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	aiModal: '',
	ollamaURL: 'http://localhost:11434',
}

// ToDo: Add configurable settings for:
// - Temperature
// - top_p
// - top_k (see: https://ollama.readthedocs.io/en/modelfile/#valid-parameters-and-values)

