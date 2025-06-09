import {ItemView, WorkspaceLeaf} from "obsidian";
import {ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {Message} from "../types";
import {getTimestampFromDate} from "../utils";
import {ChatLoadingAnimation} from "./ui/chat-loading-animation";
import {ChatConversationWindow} from "./ui/chat-conversation-window";
import {ChatButtons} from "./ui/chat-buttons";

export class ChatWindow extends ItemView {
	plugin: OllamaPlugin;
	buttons: ChatButtons;
	loader: ChatLoadingAnimation;
	conversationWindow: ChatConversationWindow;
	questionTextbox: HTMLTextAreaElement
	chatContainer: Element;
	chatStarted: Date;
	messages: Message[];
	questionArea: HTMLDivElement;

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
		this.questionTextbox.disabled = isDisabled;
		if(isDisabled) {
			this.loader.show()
			this.buttons.disableButtons()
		}else{
			this.loader.hide();
			this.buttons.enableButtons()
		}
	}

	scrollToEnd() {
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	async generateConvo(query: string) {
		await this.conversationWindow.addToConversation(query, false)
		this.messages.push({role: 'user', content: query, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToEnd()

		// Query AI & add response to conversation
		const answer = await this.plugin.ai.sendQuestion(query)
		await this.conversationWindow.addToConversation(answer, true)
		this.messages.push({role: 'assistant', content: answer, timestamp: getTimestampFromDate(new Date()) });
		this.scrollToEnd()
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
		this.addQuestionArea();
		this.buttons = new ChatButtons(this)
		this.setDisabledState(false)
	}

	async onClose() {// ToDo: Check to see if there are resources to release
		// Nothing to clean up.
	}
}
