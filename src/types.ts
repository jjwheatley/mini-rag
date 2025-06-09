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

export interface UIElements {
	questionTextbox: HTMLTextAreaElement
	buttons: HTMLButtonElement[];
	loader: HTMLSpanElement;
	conversationBox: HTMLDivElement;
	chatContainer: Element;
}
