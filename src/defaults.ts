import {PluginSettings} from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	aiModel: '',
	embeddingModel: 'nomic-embed-text',
	ragTopK: 3,
	ollamaURL: 'http://localhost:11434',
	temperature: 0.1,
	isContextFreeChatsEnabled: false,
	lastContextPath: null,
	lastContextType: null,
}

