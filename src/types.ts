export interface PluginSettings {
	aiModel: string;
	ollamaURL: string;
	temperature: number;
}

export interface Message {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}
