import {PluginSettings} from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	aiModel: '',
	ollamaURL: 'http://localhost:11434',
	temperature: 0.1,
	isContextFreeChatsEnabled: false,
}

// ToDo: Add configurable settings for:
// - Temperature
// - top_p
// - top_k (see: https://ollama.readthedocs.io/en/modelfile/#valid-parameters-and-values)

