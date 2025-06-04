import {ItemView, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import {OllamaWrapper} from "./ollama-wrapper";
import OllamaPlugin from "../../main";
import {PluginSettings} from "../types";

export class PanelView extends ItemView {
	settings: PluginSettings;
	ai: OllamaWrapper

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin, initialContext?: string) {
		super(leaf);
		this.icon = ICON_NAME
		this.settings = plugin.settings;
		this.ai = new OllamaWrapper(plugin.settings, initialContext);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'AI Chat';
	}

	async addToConversation(conversation: HTMLDivElement, text: string, isResponse: boolean) {
		if (!isResponse) {
			conversation.createEl('div', { text: text, cls: "ollamaPluginConvoBox query" });
		}else{
			conversation.createEl('div', { text: text, cls: "ollamaPluginConvoBox response" });
		}
	}

	async askQuestion(questionTextArea:HTMLTextAreaElement, conversation: HTMLDivElement) {
		// Move Query from textArea to Conversation
		const query = questionTextArea.value
		questionTextArea.value = '';
		await this.addToConversation(conversation, query, false)

		// Query AI & add response to conversation
		console.log("Sending... " + query);
		const answer = await this.ai.askQuestion(query)
		console.log("Answer Received... ", answer)
		await this.addToConversation(conversation, answer, true)
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.classList.add("panelViewContainer");

		const conversationBox = container.createEl("div", {cls: "conversationBox"});
		conversationBox.createEl('h3', { text: 'Chat with ' + this.settings.aiModal});

		const questionBox = container.createEl("div")
		questionBox.createEl('h4', { text: 'Ask a question...' });
		const question = questionBox.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		const sendButton = questionBox.createEl("button", {text: "Send"})
		sendButton.addEventListener("click", async () => {
			await this.askQuestion(question, conversationBox)
		})
	}

	async onClose() {
		// Nothing to clean up.
	}
}
