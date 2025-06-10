import {Notice} from "obsidian";
import OllamaPlugin from "../../../main";
import {CSS_CLASS_PREFIX} from "../../constants";

export class ChatConversationWindow {
	htmlElement: HTMLSpanElement;
	plugin: OllamaPlugin;

	constructor(plugin: OllamaPlugin, parent: Element) {
		this.plugin = plugin;
		this.htmlElement = parent.createEl("div");
		this.addConvoHeading();
	}

	addConvoHeading(chatSubject?: string) {
		this.htmlElement.createEl('h3', { text: 'Mini-RAG Chat with ' + this.plugin.getModelUserFriendlyName()});
		this.htmlElement.createEl('div', { text: chatSubject ? 'Context: ' + chatSubject : "Context-Free"});
	}

	async addToConversation(text: string, isResponse: boolean) {
		const element = this.htmlElement.createEl('div', { text: text, cls: CSS_CLASS_PREFIX+"ConvoBox " + (isResponse ? "response" : "query")});

		element.onclick = async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Message Copied");
		}
	}

	clear(){
		this.htmlElement.empty();
	}
}
