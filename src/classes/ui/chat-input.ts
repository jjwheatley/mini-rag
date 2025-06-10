import {ChatWindow} from "../chat-window";
import {CSS_CLASS_PREFIX} from "../../constants";

export class ChatInput{
	chatWindow: ChatWindow;
	htmlElement: HTMLTextAreaElement;

	constructor(chatWindow: ChatWindow){
		this.chatWindow = chatWindow;
	}

	init(){
		this.htmlElement = this.chatWindow.inputWrapper.createEl('textarea', {
			placeholder: 'Type your question here',
			cls: CSS_CLASS_PREFIX+"QuestionBox"
		});
		this.htmlElement.addEventListener("keyup", async (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				await this.chatWindow.sendInputAsChatMessage();
			}
		})
	}

	getValue(){
		return this.htmlElement.value;
	}

	setValue(value: string){
		this.htmlElement.value = value;
	}

	clear(){
		this.setValue("");
	}

	disable(){
		this.htmlElement.disabled = true;
	}

	enable(){
		this.htmlElement.disabled = false;
	}
}
