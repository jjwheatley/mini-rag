import {ItemView, WorkspaceLeaf} from "obsidian";
import {VIEW_TYPE} from "../constants";
import {OllamaWrapper} from "./ollama-wrapper";
import OllamaPlugin from "../../main";
import {PluginSettings} from "../types";

export class PanelView extends ItemView {
	settings: PluginSettings;


	constructor(leaf: WorkspaceLeaf, plugin: OllamaPlugin) {
		super(leaf);
		this.icon = "brain"
		this.settings = plugin.settings;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'Example view';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.classList.add("panelViewContainer");

		const conversationBox = container.createEl("div")
		conversationBox.createEl('h3', { text: 'Chat with ' + this.settings.aiModal});
		// conversationBox.createEl('div', { text: 'Hello, what can I help you with?', cls: "ollamaPluginConvoBox" });

		const questionBox = container.createEl("div")
		questionBox.createEl('h4', { text: 'Ask a question...' });
		const question = questionBox.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
		const sendButton = questionBox.createEl("button", {text: "Send"})
		sendButton.addEventListener("click", async () => {
			console.log("Sending..." + question.value);
			const AI = new OllamaWrapper(this.settings);
			let answer = await AI.askQuestion(question.value)
			console.log(answer);
			//ToDo:
			// - Append `question.value` to conversation
			// - Send to Ollama
			// - Append Answer to conversation
		})
	}


	async onClose() {
		// Nothing to clean up.
	}
}
