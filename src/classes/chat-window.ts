import {ItemView, Notice, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message} from "../types";
import {getTimestampFromDate} from "../utils";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	chatStarted: Date;
	messages: Message[];
	questionTextbox: HTMLTextAreaElement
	questionTextBoxDisabled: boolean

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
		this.chatStarted = new Date();
		this.messages = [];
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'AI Chat';//ToDo: Update to something meaningful
	}

	disableInput(){
		this.questionTextBoxDisabled = true
		this.setInputDisabledState()
	}

	enableInput(){
		this.questionTextBoxDisabled = false;
		this.setInputDisabledState()
	}

	setInputDisabledState() {
		this.questionTextbox.disabled = this.questionTextBoxDisabled;
	}

	async addToConversation(conversation: HTMLDivElement, text: string, isResponse: boolean) {
		const element = conversation.createEl('div', { text: text, cls: "ollamaPluginConvoBox " + (isResponse ? "response" : "query")});

		element.onclick = async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Message Copied")
		}
	}

	scrollToBottomOfElement(element: Element) {
		element.scrollTop = element.scrollHeight;
	}

	async generateConvo(questionTextArea:HTMLTextAreaElement, conversation: HTMLDivElement, container: Element) {
		// Move Query from textArea to Conversation
		const query = questionTextArea.value
		questionTextArea.value = '';
		await this.addToConversation(conversation, query, false)
		this.messages.push({role: 'user', content: query, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(container)

		// Query AI & add response to conversation
		const answer = await this.plugin.ai.askQuestion(query)
		await this.addToConversation(conversation, answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(container)
	}

	addConversationBox(container: Element, chatSubject?: string){
		const conversationBox = container.createEl("div", {cls: "conversationBox"});
		conversationBox.createEl('h3', { text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		conversationBox.createEl('div', { text: chatSubject ? 'Context: ' + chatSubject : "Context-Free"});
		return conversationBox;
	}

	addQuestionBox(container: Element){

		const questionBox = container.createEl("div")
		questionBox.createEl('h4', { text: 'Ask a question...' });
		this.questionTextbox = questionBox.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		this.setInputDisabledState()
		return questionBox;
	}

	addSendButton(questionBox: HTMLDivElement, conversationBox: HTMLDivElement, chatContainer: Element) {
		const sendButton = questionBox.createEl("button", {text: "Send"})
		sendButton.addEventListener("click", async () => {
			await this.generateConvo(this.questionTextbox, conversationBox, chatContainer)
		})
	}

	addSaveButton(questionBox: HTMLDivElement) {
		const saveButton = questionBox.createEl("button", {text: "Save"})
		saveButton.addEventListener("click", async () => {
			await this.plugin.saveChat()
		})
	}

	resetChatContainer(){
		const containerElement = this.containerEl.children[1];
		containerElement.empty();
		containerElement.classList.add("panelViewContainer");
		return containerElement;
	}

	resetChat(chatSubject?: string){
		this.chatStarted = new Date();
		this.messages = [];

		const chatContainer = this.resetChatContainer()
		const conversationBox = this.addConversationBox(chatContainer, chatSubject);
		const questionBox = this.addQuestionBox(chatContainer);

		//ToDo: Add support for custom buttons with prompts configurable in settings
		this.addSendButton(questionBox, conversationBox, chatContainer);
		this.addSaveButton(questionBox)
	}

	async onOpen() {
		this.resetChat()
	}

	async onClose() {
		// Nothing to clean up.
	}
}
