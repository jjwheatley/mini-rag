import {Message, MessageRoles} from "../../types";
import {getTimestampFromDate} from "../../utils";


export class ChatMessages{
	messages: Message[];

	constructor() {
		this.messages = [];
	}

	addMessage(content: string, role: MessageRoles): void {
		this.messages.push({role, content, timestamp: getTimestampFromDate(new Date())})
	}

	addUserMessage(message: string): void {
		this.addMessage(message, 'user');
	}

	addAssistantMessage(message: string): void {
		this.addMessage(message, 'assistant');
	}

	clear(){
		this.messages = [];
	}

	get(){
		return this.messages;
	}
}
