import {ItemView, WorkspaceLeaf} from "obsidian";
import {VIEW_TYPE} from "../constants";

export class PanelView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "brain"
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
		container.createEl('h4', { text: 'Example view' });
		container.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
	}

	async onClose() {
		// Nothing to clean up.
	}
}
