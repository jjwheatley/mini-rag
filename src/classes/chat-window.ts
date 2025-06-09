import {ItemView, Notice, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message, UIElements} from "../types";
import {getTimestampFromDate} from "../utils";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	chatStarted: Date;
	messages: Message[];
	uiDisabled: boolean
	uiElements: UIElements;

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
		this.chatStarted = new Date();
		this.messages = [];
		this.uiElements.buttons = [];
		this.uiElements.chatContainer = this.containerEl.children[1]
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
			this.uiElements.loader.classList.remove("hidden");
		}else{
			this.uiElements.loader.classList.add("hidden");
		}
	}

	setUIDisabledState() {
		this.uiElements.questionTextbox.disabled = this.uiDisabled;
		this.setLoaderState(this.uiDisabled)

		if(this.uiDisabled) {
			for(const button of this.uiElements.buttons)
				button.disabled = true
		}else{
			for(const button of this.uiElements.buttons)
				button.removeAttribute('disabled');
		}
	}

	async addToConversation(text: string, isResponse: boolean) {
		const element = this.uiElements.conversationBox.createEl('div', { text: text, cls: "ollamaPluginConvoBox " + (isResponse ? "response" : "query")});

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
		this.scrollToBottomOfElement(this.uiElements.chatContainer)

		// Query AI & add response to conversation
		const answer = await this.plugin.ai.sendQuestion(query)
		await this.addToConversation(answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(this.uiElements.chatContainer)
	}

	addConversationBox(chatSubject?: string){
		this.uiElements.conversationBox = this.uiElements.chatContainer.createEl("div", {cls: "conversationBox"});
		this.uiElements.conversationBox.createEl('h3', { text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		this.uiElements.conversationBox.createEl('div', { text: chatSubject ? 'Context: ' + chatSubject : "Context-Free"});
	}

	async sendInputToConversation() {
		const query = this.uiElements.questionTextbox.value;
		this.uiElements.questionTextbox.value = "";
		await this.generateConvo(query);
	}

	addQuestionArea(){
		const questionArea = this.uiElements.chatContainer.createEl("div");
		questionArea.createEl('h4', { text: 'Ask a question...' });
		this.uiElements.questionTextbox = questionArea.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		this.uiElements.questionTextbox.addEventListener("keyup", async (event) => {
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
		this.uiElements.buttons.push(sendButton);
	}

	addSaveButton(parentEl: HTMLDivElement) {
		const saveButton = parentEl.createEl("button", {text: "Save"});
		saveButton.addEventListener("click", async () => {
			if(!this.uiDisabled) await this.plugin.saveChat()
		})
		this.uiElements.buttons.push(saveButton);
	}

	addSummarizeButton(parentEl: HTMLDivElement) {
		const summarizeButton = parentEl.createEl("button", {text: "Summarize"})
		summarizeButton.addEventListener("click", async () => {
			if(!this.uiDisabled) await this.generateConvo("Summarize the file")
		})
		this.uiElements.buttons.push(summarizeButton);
	}

	addButtonAreas(container: Element) {
		const parent = container.createEl("div", {cls: "buttonArea"});
		const left = parent.createEl("div", {cls: "buttonArea left"});
		const right = parent.createEl("div", {cls: "buttonArea right"});
		return [left, right];
	}

	addLoader(){
		this.uiElements.loader = this.uiElements.chatContainer.createEl("span", {cls: "loader"});
	}

	resetChatContainer(){
		this.uiElements.chatContainer.empty();
		this.uiElements.chatContainer.classList.add("panelViewContainer");
	}

	clearButtonList(){
		this.uiElements.buttons = [];
	}

	resetChat(chatSubject?: string){
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
