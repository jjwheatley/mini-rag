import {Message, MessageRoles} from "../../types";
import {getTimestampFromDate} from "../../utils";

export class ChatMessages {
	private messages: Message[];

	constructor() {
		this.messages = [];
	}

	addMessage(content: string, role: MessageRoles): void {
		this.messages.push({role, content, timestamp: getTimestampFromDate(new Date())});
	}

	addUserMessage(message: string): void {
		this.addMessage(message, "user");
	}

	beginAssistantMessage(): void {
		this.messages.push({
			role: "assistant",
			content: "",
			timestamp: getTimestampFromDate(new Date()),
		});
	}

	setLastAssistantContent(content: string): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant") {
			last.content = content;
		}
	}

	removeLastMessage(): void {
		this.messages.pop();
	}

	clear() {
		this.messages = [];
	}

	get() {
		return this.messages;
	}
}
