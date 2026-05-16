import {ChatWindow} from "../chat-window";
import {CSS_CLASS_PREFIX} from "../../constants";

export class ChatInput {
	chatWindow: ChatWindow;
	htmlElement: HTMLTextAreaElement;
	private sendEnabled = true;

	constructor(chatWindow: ChatWindow) {
		this.chatWindow = chatWindow;
	}

	init() {
		this.htmlElement = this.chatWindow.inputWrapper.createEl("textarea", {
			placeholder: "Type your question here",
			cls: CSS_CLASS_PREFIX + "question-box",
		});
		this.chatWindow.registerDomEvent(this.htmlElement, "keydown", async (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (this.sendEnabled) {
					await this.chatWindow.sendInputAsChatMessage();
				}
			}
		});
	}

	canSend(): boolean {
		return this.sendEnabled;
	}

	setSendEnabled(enabled: boolean) {
		this.sendEnabled = enabled;
	}

	getValue() {
		return this.htmlElement.value;
	}

	setValue(value: string) {
		this.htmlElement.value = value;
	}

	clear() {
		this.setValue("");
	}

	focusIfActiveView() {
		const activeChatView = this.chatWindow.app.workspace.getActiveViewOfType(ChatWindow);
		if (activeChatView === this.chatWindow) {
			requestAnimationFrame(() => this.htmlElement.focus());
		}
	}
}
