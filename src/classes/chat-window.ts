import {ItemView, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message} from "../types";
import {getTimestampFromDate} from "../utils";
import {LoadingAnimation} from "./ui/loading-animation";
import {ConversationWindow} from "./ui/conversationWindow";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	chatStarted: Date;
	messages: Message[];
	uiDisabled: boolean
	questionTextbox: HTMLTextAreaElement
	buttons: HTMLButtonElement[];
	loader: LoadingAnimation;
	conversationWindow: ConversationWindow;
	chatContainer: Element;
	questionArea: HTMLDivElement;

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
		this.chatStarted = new Date();
		this.messages = [];
		this.buttons = [];
		this.chatContainer = this.containerEl.children[1]
		this.chatContainer.classList.add("chatContainer");
		this.conversationWindow = new ConversationWindow(plugin, this.chatContainer)
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
			this.loader.show()
		}else{
			this.loader.hide();
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

	scrollToBottomOfElement(element: Element) {
		element.scrollTop = element.scrollHeight;
	}

	async generateConvo(query: string) {
		await this.conversationWindow.addToConversation(query, false)
		this.messages.push({role: 'user', content: query, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(this.chatContainer)

		// Query AI & add response to conversation
		const answer = await this.plugin.ai.sendQuestion(query)
		await this.conversationWindow.addToConversation(answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToBottomOfElement(this.chatContainer)
	}

	async sendInputToConversation() {
		const query = this.questionTextbox.value;
		this.questionTextbox.value = "";
		await this.generateConvo(query);
	}

	addQuestionArea(){
		this.questionArea = this.chatContainer.createEl("div");
		this.questionArea.createEl('h4', { text: 'Ask a question...' });
		this.questionTextbox = this.questionArea.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		this.questionTextbox.addEventListener("keyup", async (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				await this.sendInputToConversation();
			}
		})
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
		this.loader = new LoadingAnimation(this.chatContainer)
	}

	clearButtonList(){
		this.buttons = [];
	}

	resetChat(chatSubject?: string){
		// Clear/remove previous elements
		this.chatStarted = new Date();
		this.messages = [];
		this.conversationWindow.clear()
		// Rebuild UI
		this.conversationWindow.addConvoHeading(chatSubject)
		if(chatSubject !== undefined) {
			this.showSummarizeButton()
		}else {
			this.hideSummarizeButton()
		}

		//Ensure UI state is respected
		this.setUIDisabledState()
	}

	showSummarizeButton(){
		this.buttons[1].style.display = "inline-flex";
	}

	hideSummarizeButton(){
		this.buttons[1].style.display = "none";
	}

	async onOpen() {
		// Clear/remove previous elements
		this.chatStarted = new Date();
		this.messages = [];
		this.clearButtonList();
		// Rebuild UI
		this.addLoader()
		this.addQuestionArea();
		const [leftButtonArea, rightButtonArea] = this.addButtonAreas(this.questionArea)
		this.addSaveButton(leftButtonArea)
		this.addSummarizeButton(leftButtonArea)
		this.hideSummarizeButton()
		this.addSendButton(rightButtonArea);

		//Ensure UI state is respected
		this.setUIDisabledState()
	}

	async onClose() {// ToDo: Check to see if there are resources to release
		// Nothing to clean up.
	}
}
