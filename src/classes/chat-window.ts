import {ItemView, Notice, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message} from "../types";
import {getTimestampFromDate} from "../utils";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	chatStarted: Date;
	messages: Message[];
	uiDisabled: boolean
	questionTextbox: HTMLTextAreaElement
	buttons: HTMLButtonElement[];
	loader: HTMLSpanElement;
	conversationBox: HTMLDivElement;
	chatContainer: Element;

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
		this.chatStarted = new Date();
		this.messages = [];
		this.buttons = [];
		this.chatContainer = this.containerEl.children[1]
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'AI Chat';//ToDo: Update to something meaningful
	}

	freezeUI(){
		this.uiDisabled = true
		this.setUIDisabledState()
	}

	unfreezeUI(){
		this.uiDisabled = false;
		this.setUIDisabledState()
	}

	setLoaderState(showLoader: boolean) {
		if(showLoader){
			this.loader.classList.remove("hidden");
		}else{
			this.loader.classList.add("hidden");
		}
	}

	setUIDisabledState() {
		this.questionTextbox.disabled = this.uiDisabled;
		this.setLoaderState(this.uiDisabled)

		if(this.uiDisabled) {
			for(const button of this.buttons)
				button.disabled = true
		}else{
			for(const button of this.buttons)
				button.removeAttribute('disabled');
		}
	}

	async addToConversation(text: string, isResponse: boolean) {
		const element = this.conversationBox.createEl('div', { text: text, cls: "ollamaPluginConvoBox " + (isResponse ? "response" : "query")});

		element.onclick = async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Message Copied")
		}
	}

	scrollToBottomOfElement(element: Element) {
		element.scrollTop = element.scrollHeight;
	}

	async generateConvo(query: string) {
		await this.addToConversation(query, false)
		this.messages.push({role: 'user', content: query, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(this.chatContainer)

		// Query AI & add response to conversation
		const answer = await this.plugin.ai.sendQuestion(query)
		await this.addToConversation(answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(this.chatContainer)
	}

	addConversationBox(chatSubject?: string){
		this.conversationBox = this.chatContainer.createEl("div", {cls: "conversationBox"});
		this.conversationBox.createEl('h3', { text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		this.conversationBox.createEl('div', { text: chatSubject ? 'Context: ' + chatSubject : "Context-Free"});
	}

	async sendInputToConversation() {
		const query = this.questionTextbox.value;
		this.questionTextbox.value = "";
		await this.generateConvo(query);
	}

	addQuestionArea(){
		const questionArea = this.chatContainer.createEl("div");
		questionArea.createEl('h4', { text: 'Ask a question...' });
		this.questionTextbox = questionArea.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		this.questionTextbox.addEventListener("keyup", async (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				await this.sendInputToConversation();
			}
		})
		return questionArea;
	}

	addSendButton(parentEl: HTMLDivElement) {
		const sendButton = parentEl.createEl("button", {text: "Send", cls: "ollamaPluginSendButton"})
		sendButton.addEventListener("click", async () => {
			if(!this.uiDisabled){
				await this.sendInputToConversation();
			}
		})
		this.buttons.push(sendButton);
	}

	addSaveButton(parentEl: HTMLDivElement) {
		const saveButton = parentEl.createEl("button", {text: "Save"});
		saveButton.addEventListener("click", async () => {
			if(!this.uiDisabled) await this.plugin.saveChat()
		})
		this.buttons.push(saveButton);
	}

	addSummarizeButton(parentEl: HTMLDivElement) {
		const summarizeButton = parentEl.createEl("button", {text: "Summarize"})
		summarizeButton.addEventListener("click", async () => {
			if(!this.uiDisabled) await this.generateConvo("Summarize the file")
		})
		this.buttons.push(summarizeButton);
	}

	addButtonAreas(container: Element) {
		const parent = container.createEl("div", {cls: "buttonArea"});
		const left = parent.createEl("div", {cls: "buttonArea left"});
		const right = parent.createEl("div", {cls: "buttonArea right"});
		return [left, right];
	}

	addLoader(){
		this.loader = this.chatContainer.createEl("span", {cls: "loader"});
	}

	resetChatContainer(){
		this.chatContainer.empty();
		this.chatContainer.classList.add("panelViewContainer");
	}

	clearButtonList(){
		this.buttons = [];
	}

	resetChat(chatSubject?: string){ // ToDo: Reset only the chat
		// Clear/remove previous elements
		this.chatStarted = new Date();
		this.messages = [];
		this.clearButtonList();
		this.resetChatContainer() // Fetch a fresh chat container

		// Rebuild UI
		this.addConversationBox(chatSubject);
		this.addLoader()
		const questionArea = this.addQuestionArea();
		const [leftButtonArea, rightButtonArea] = this.addButtonAreas(questionArea)
		this.addSaveButton(leftButtonArea)
		if(chatSubject) this.addSummarizeButton(leftButtonArea)
		this.addSendButton(rightButtonArea);

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
