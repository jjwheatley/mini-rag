import {ChatWindow} from "../chat-window";
import {CSS_CLASS_PREFIX} from "../../constants";

export class ChatButtons{
	chatWindow: ChatWindow
	private saveButton: HTMLButtonElement
	private summarizeButton: HTMLButtonElement
	private sendButton: HTMLButtonElement
	private blockButtonEvents: boolean

	constructor(chatWindow: ChatWindow){
		this.chatWindow = chatWindow
	}

	init(){
		const [left, right] = this.addButtonAreas(this.chatWindow.inputWrapper)
		this.saveButton = this.addSaveButton(left)
		this.summarizeButton = this.addSummarizeButton(left)
		this.hideSummarizeButton()
		this.sendButton = this.addSendButton(right)
		this.blockButtonEvents = false
	}


	addButtonAreas(container: Element) {
		const parent = container.createEl("div", {cls: CSS_CLASS_PREFIX+"ButtonArea"});
		const left = parent.createEl("div", {cls: CSS_CLASS_PREFIX+"ButtonArea left"});
		const right = parent.createEl("div", {cls: CSS_CLASS_PREFIX+"ButtonArea right"});
		return [left, right];
	}

	addSaveButton(parentEl: HTMLDivElement) {
		const saveButton = parentEl.createEl("button", {text: "Save"});
		saveButton.addEventListener("click", async () => {
			if(!this.blockButtonEvents) {
				await this.chatWindow.plugin.saveChat()
			}
		})
		return saveButton;
	}

	addSummarizeButton(parentEl: HTMLDivElement) {
		const summarizeButton = parentEl.createEl("button", {text: "Summarize"})
		summarizeButton.addEventListener("click", async () => {
			if (!this.blockButtonEvents) {
				await this.chatWindow.sendTextAsChatMessage("Summarize the file")
			}
		})
		return  summarizeButton;
	}

	addSendButton(parentEl: HTMLDivElement) {
		const sendButton = parentEl.createEl("button", {text: "Send", cls: CSS_CLASS_PREFIX+"SendButton"})
		sendButton.addEventListener("click", async () => {
			if(!this.blockButtonEvents){
				await this.chatWindow.sendInputAsChatMessage();
			}
		})
		return  sendButton;
	}

	disableButtons(){
		this.blockButtonEvents = true
		this.saveButton.disabled = true
		this.summarizeButton.disabled = true
		this.sendButton.disabled = true

	}

	enableButtons(){
		this.blockButtonEvents = false
		this.saveButton.removeAttribute('disabled');
		this.summarizeButton.removeAttribute('disabled');
		this.sendButton.removeAttribute('disabled');
	}

	showSummarizeButton(){
		this.summarizeButton.style.display = "inline-flex";
	}

	hideSummarizeButton(){
		this.summarizeButton.style.display = "none";
	}
}
