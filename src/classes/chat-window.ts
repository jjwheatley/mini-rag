import {ItemView, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message} from "../types";
import {getTimestampFromDate} from "../utils";
import {ChatLoadingAnimation} from "./ui/chat-loading-animation";
import {ChatConversationWindow} from "./ui/chat-conversation-window";
import {ChatButtons} from "./ui/chat-buttons";
import {ChatInput} from "./ui/chat-input";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	buttons: ChatButtons;
	loader: ChatLoadingAnimation;
	conversationWindow: ChatConversationWindow;
	input: ChatInput
	chatContainer: Element;
	chatStarted: Date;
	messages: Message[];
	inputWrapper: HTMLDivElement;

	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = ICON_NAME
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'AI Chat';//ToDo: Update to something meaningful
	}

	setDisabledState(isDisabled: boolean){
		if(isDisabled) {
			this.loader.show()
			this.buttons.disableButtons()
			this.input.disable()
		}else{
			this.loader.hide();
			this.buttons.enableButtons()
			this.input.enable()
		}
	}

	scrollToEnd() {
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	async sendTextAsChatMessage(text: string) {
		// Add user's Query to conversation
		await this.conversationWindow.addToConversation(text, false)
		this.messages.push({role: 'user', content: text, timestamp: getTimestampFromDate(new Date())});
		this.scrollToEnd()
		// Query AI & add response to conversation
		const answer = await this.plugin.ai.sendQuestion(text)
		await this.conversationWindow.addToConversation(answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date())});
		this.scrollToEnd()
	}

	async sendInputAsChatMessage() {
		const inputText = this.input.getValue();
		this.input.clear();
		await this.sendTextAsChatMessage(inputText);
	}

	initInputArea(){
		this.inputWrapper = this.chatContainer.createEl("div");
		this.inputWrapper.createEl('h4', { text: 'Ask a question...' });
		this.input = new ChatInput(this)
		this.input.init()
		this.buttons = new ChatButtons(this)
		this.buttons.init()
	}

	resetChat(chatSubject?: string){
		this.messages = [];
		this.chatStarted = new Date();
		this.conversationWindow.clear()
		this.conversationWindow.addConvoHeading(chatSubject)
		if(chatSubject !== undefined) {
			this.buttons.showSummarizeButton()
		}else {
			this.buttons.hideSummarizeButton()
		}
	}

	async onOpen() {
		this.messages = [];
		this.chatStarted = new Date();
		this.chatContainer = this.containerEl.children[1]
		this.chatContainer.classList.add("chatContainer");
		this.conversationWindow = new ChatConversationWindow(this.plugin, this.chatContainer)
		this.loader = new ChatLoadingAnimation(this.chatContainer)
		this.initInputArea();
		this.setDisabledState(false)
	}

	async onClose() {// ToDo: Check to see if there are resources to release
		// Nothing to clean up.
	}
}
