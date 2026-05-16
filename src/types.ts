export interface PluginSettings {
	aiModel: string;
	embeddingModel: string;
	ragTopK: number;
	ollamaURL: string;
	temperature: number;
	isContextFreeChatsEnabled: boolean;
	lastContextPath: string | null;
	lastContextType: 'file' | 'folder' | null;
}

export type MessageRoles = 'user' | 'assistant';

export interface Message {
	role: MessageRoles
	content: string;
	timestamp: string;
}
