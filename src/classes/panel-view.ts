import {ItemView, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";

export class PanelView extends ItemView {
	plugin: OllamaPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
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

	async generateConvo(questionTextArea:HTMLTextAreaElement, conversation: HTMLDivElement) {
		// Move Query from textArea to Conversation
		const query = questionTextArea.value
		questionTextArea.value = '';
		await this.addToConversation(conversation, query, false)

		// Query AI & add response to conversation
		// console.log("Sending... " + query);
		const answer = await this.plugin.ai.askQuestion(query)
		// console.log("Answer Received... ", answer)
		await this.addToConversation(conversation, answer, true)
	}

	resetChat(chatSubject?: string){
		const container = this.containerEl.children[1];
		container.empty();
		container.classList.add("panelViewContainer");

		const conversationBox = container.createEl("div", {cls: "conversationBox"});
		conversationBox.createEl('h3', { text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		if(chatSubject)
			conversationBox.createEl('div', { text: 'Subject: ' + chatSubject});

		const questionBox = container.createEl("div")
		questionBox.createEl('h4', { text: 'Ask a question...' });
		const question = questionBox.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		const sendButton = questionBox.createEl("button", {text: "Send"})

		//ToDo: Add support for custom buttons with prompts configurable in settings
		sendButton.addEventListener("click", async () => {
			await this.generateConvo(question, conversationBox)
		})
	}

	async onOpen() {
		this.resetChat()
	}

	async onClose() {
		// Nothing to clean up.
	}
}
