export interface PluginSettings {
	aiModel: string;
	ollamaURL: string;
	temperature: number;
	isContextFreeChatsEnabled: boolean;
}

export type MessageRoles = 'user' | 'assistant';

export interface Message {
	role: MessageRoles
	content: string;
	timestamp: string;
}
