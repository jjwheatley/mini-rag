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

	async generateConvo(query: string, conversation: HTMLDivElement, container: Element) {
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

	addQuestionArea(container: Element){
		const questionArea = container.createEl("div")
		questionArea.createEl('h4', { text: 'Ask a question...' });
		this.questionTextbox = questionArea.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		this.setInputDisabledState()
		return questionArea;
	}

	addSendButton(parentEl: HTMLDivElement, conversationBox: HTMLDivElement, chatContainer: Element) {
		const sendButton = parentEl.createEl("button", {text: "Send", cls: "ollamaPluginSendButton"})
		sendButton.addEventListener("click", async () => {
			const query = this.questionTextbox.value
			this.questionTextbox.value = ""
			await this.generateConvo(query, conversationBox, chatContainer)
		})
	}

	addSaveButton(parentEl: HTMLDivElement) {
		const saveButton = parentEl.createEl("button", {text: "Save"});
		saveButton.addEventListener("click", async () => {
			await this.plugin.saveChat()
		})
	}

	addSummarizeButton(parentEl: HTMLDivElement, conversationBox: HTMLDivElement, chatContainer: Element) {
		const summarizeButton = parentEl.createEl("button", {text: "Summarize"})
		summarizeButton.addEventListener("click", async () => {
			await this.generateConvo("Summarize the file", conversationBox, chatContainer)
		})

	}

	addButtonAreas(container: Element) {
		const parent = container.createEl("div", {cls: "buttonArea"});
		const left = parent.createEl("div", {cls: "buttonArea left"});
		const right = parent.createEl("div", {cls: "buttonArea right"});
		return [left, right];
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
		const questionArea = this.addQuestionArea(chatContainer);

		const [leftButtonArea, rightButtonArea] = this.addButtonAreas(questionArea)
		this.addSaveButton(leftButtonArea)
		if(chatSubject) this.addSummarizeButton(leftButtonArea, conversationBox, chatContainer)

		this.addSendButton(rightButtonArea, conversationBox, chatContainer);
	}

	async onOpen() {
		this.resetChat()
	}

	async onClose() {
		// Nothing to clean up.
	}
}
