import {Notice} from "obsidian";
import OllamaPlugin from "../../../main";

export class ChatConversationWindow {
	htmlElement: HTMLSpanElement;
	plugin: OllamaPlugin

	constructor(plugin: OllamaPlugin, parent: Element) {
		this.plugin = plugin
		this.htmlElement = parent.createEl("div", {cls: "conversationBox"});
		this.addConvoHeading()
	}

	clear(){
		this.htmlElement.empty()
	}

	async addToConversation(text: string, isResponse: boolean) {
		const element = this.htmlElement.createEl('div', { text: text, cls: "ollamaPluginConvoBox " + (isResponse ? "response" : "query")});

		element.onclick = async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Message Copied")
		}
	}

	addConvoHeading(chatSubject?: string) {
		this.htmlElement.createEl('h3', { text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		this.htmlElement.createEl('div', { text: chatSubject ? 'Context: ' + chatSubject : "Context-Free"});
	}
}
