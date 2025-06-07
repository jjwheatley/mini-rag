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
	buttons: HTMLButtonElement[];
	uiDisabled: boolean

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
		this.chatStarted = new Date();
		this.messages = [];
		this.buttons = [];
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'AI Chat';//ToDo: Update to something meaningful
	}

	disableInput(){
		this.uiDisabled = true
		this.setUIDisabledState()
	}

	enableInput(){
		this.uiDisabled = false;
		this.setUIDisabledState()
	}

	setUIDisabledState() {
		this.questionTextbox.disabled = this.uiDisabled;
		const buttons = this.buttons;

		for(let i = 0; i < buttons.length; i++){
			if(this.uiDisabled){
				buttons[i].disabled = true
			}else{
				buttons[i].removeAttribute('disabled');
			}
		}
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
		return questionArea;
	}

	addSendButton(parentEl: HTMLDivElement, conversationBox: HTMLDivElement, chatContainer: Element) {
		const sendButton = parentEl.createEl("button", {text: "Send", cls: "ollamaPluginSendButton"})
		sendButton.addEventListener("click", async () => {
			if(!this.uiDisabled){
				const query = this.questionTextbox.value
				this.questionTextbox.value = ""
				await this.generateConvo(query, conversationBox, chatContainer)
			}
		})
		this.buttons.push(sendButton);
	}

	addSaveButton(parentEl: HTMLDivElement) {
		const saveButton = parentEl.createEl("button", {text: "Save"});
		saveButton.disabled = true
		saveButton.addEventListener("click", async () => {
			if(!this.uiDisabled){
				await this.plugin.saveChat()
			}
		})
		this.buttons.push(saveButton);
	}

	addSummarizeButton(parentEl: HTMLDivElement, conversationBox: HTMLDivElement, chatContainer: Element) {
		const summarizeButton = parentEl.createEl("button", {text: "Summarize"})
		summarizeButton.addEventListener("click", async () => {
			if(!this.uiDisabled) {
				await this.generateConvo("Summarize the file", conversationBox, chatContainer)
			}
		})
		this.buttons.push(summarizeButton);
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

	clearButtonList(){
		this.buttons = [];
	}

	resetChat(chatSubject?: string){
		// Clear/remove previous elements
		this.chatStarted = new Date();
		this.messages = [];
		this.clearButtonList();
		const chatContainer = this.resetChatContainer() // Fetch a fresh chat container

		// Rebuild UI
		const conversationBox = this.addConversationBox(chatContainer, chatSubject);
		const questionArea = this.addQuestionArea(chatContainer);
		const [leftButtonArea, rightButtonArea] = this.addButtonAreas(questionArea)
		this.addSaveButton(leftButtonArea)
		if(chatSubject) this.addSummarizeButton(leftButtonArea, conversationBox, chatContainer)
		this.addSendButton(rightButtonArea, conversationBox, chatContainer);

		//Ensure UI state is respected
		this.setUIDisabledState()
	}

	async onOpen() {
		this.resetChat()
	}

	async onClose() {
		// Nothing to clean up.
	}
}
