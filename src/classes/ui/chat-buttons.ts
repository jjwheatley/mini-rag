import {Menu, setIcon} from "obsidian";
import {ChatWindow} from "../chat-window";
import {CSS_CLASS_PREFIX} from "../../constants";

function createIconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	extraClass?: string,
): HTMLButtonElement {
	const classes = ["clickable-icon", CSS_CLASS_PREFIX + "icon-button"];
	if (extraClass) {
		classes.push(extraClass);
	}

	const button = parent.createEl("button", {cls: classes.join(" ")});
	setIcon(button, icon);
	button.setAttr("aria-label", label);
	button.setAttr("title", label);
	return button;
}

export class ChatButtons {
	chatWindow: ChatWindow;
	private saveButton: HTMLButtonElement;
	private saveMenuButton: HTMLButtonElement;
	private summarizeButton: HTMLButtonElement;
	private sendButton: HTMLButtonElement;

	constructor(chatWindow: ChatWindow) {
		this.chatWindow = chatWindow;
	}

	init() {
		const [left, right] = this.addButtonAreas(this.chatWindow.inputWrapper);
		this.addSaveControls(left);
		this.summarizeButton = this.addSummarizeButton(left);
		this.hideSummarizeButton();
		this.sendButton = this.addSendButton(right);
	}

	private addButtonAreas(container: Element) {
		const parent = container.createEl("div", {cls: CSS_CLASS_PREFIX + "button-area"});
		const left = parent.createEl("div", {cls: CSS_CLASS_PREFIX + "button-area-left"});
		const right = parent.createEl("div", {cls: CSS_CLASS_PREFIX + "button-area-right"});
		return [left, right];
	}

	private addSaveControls(parentEl: HTMLDivElement) {
		const group = parentEl.createEl("div", {cls: CSS_CLASS_PREFIX + "save-button-group"});

		this.saveButton = createIconButton(group, "save", "Save");
		this.chatWindow.registerDomEvent(this.saveButton, "click", async () => {
			await this.chatWindow.plugin.saveChat(this.chatWindow, false);
		});

		this.saveMenuButton = createIconButton(
			group,
			"chevron-down",
			"More save options",
			CSS_CLASS_PREFIX + "save-menu-button",
		);
		const menuButton = this.saveMenuButton;
		this.chatWindow.registerDomEvent(menuButton, "click", (event) => {
			event.stopPropagation();
			this.showSaveMenu(menuButton);
		});
	}

	private showSaveMenu(anchor: HTMLElement) {
		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle("Save as…")
				.setIcon("file-plus")
				.onClick(async () => {
					await this.chatWindow.plugin.saveChat(this.chatWindow, true);
				});
		});

		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({x: rect.left, y: rect.bottom + 4});
	}

	private addSummarizeButton(parentEl: HTMLDivElement) {
		const summarizeButton = createIconButton(
			parentEl,
			"sparkles",
			"Summarize",
			CSS_CLASS_PREFIX + "summarize-button",
		);
		this.chatWindow.registerDomEvent(summarizeButton, "click", async () => {
			await this.chatWindow.summarizeContext();
		});
		return summarizeButton;
	}

	private addSendButton(parentEl: HTMLDivElement) {
		const sendButton = createIconButton(
			parentEl,
			"send",
			"Send",
			CSS_CLASS_PREFIX + "send-button",
		);
		this.chatWindow.registerDomEvent(sendButton, "click", async () => {
			await this.chatWindow.sendInputAsChatMessage();
		});
		return sendButton;
	}

	setSendEnabled(enabled: boolean) {
		this.sendButton.disabled = !enabled;
	}

	setSaveEnabled(enabled: boolean) {
		this.saveButton.disabled = !enabled;
		this.saveMenuButton.disabled = !enabled;
	}

	setSummarizeEnabled(enabled: boolean) {
		this.summarizeButton.disabled = !enabled;
	}

	hideSummarizeButton() {
		this.summarizeButton.classList.add("hidden");
	}

	showSummarizeButton() {
		this.summarizeButton.classList.remove("hidden");
	}
}
