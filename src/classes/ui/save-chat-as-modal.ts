import {App, Modal, normalizePath, Notice, Setting} from "obsidian";
import MiniRagPlugin from "../../../main";
import {ChatWindow} from "../chat-window";
import {CSS_CLASS_PREFIX, FOLDER_NAME} from "../../constants";
import {buildChatSaveFilename, normalizeChatFilename} from "../../utils";

export class SaveChatAsModal extends Modal {
	private filenameInput: HTMLInputElement | null = null;
	private isSubmitting = false;

	constructor(
		app: App,
		private plugin: MiniRagPlugin,
		private chatWindow: ChatWindow,
	) {
		super(app);
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass(CSS_CLASS_PREFIX + "save-as-modal");
		this.titleEl.setText("Save chat as");

		const suggested = buildChatSaveFilename(
			this.chatWindow.chatStarted,
			this.plugin.getModelUserFriendlyName(),
			true,
		).replace(/\.md$/i, "");

		const filenameSetting = new Setting(contentEl)
			.setName("File name")
			.setDesc(`Saved in ${FOLDER_NAME}/`)
			.addText((text) => {
				text.setPlaceholder(suggested)
					.setValue(suggested);
				this.filenameInput = text.inputEl;
				text.inputEl.addClass(CSS_CLASS_PREFIX + "save-as-filename-input");
				text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void this.submit();
					}
				});
			});
		filenameSetting.settingEl.addClass(CSS_CLASS_PREFIX + "save-as-filename");

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("Save")
				.setCta()
				.onClick(() => void this.submit()))
			.addButton((button) => button
				.setButtonText("Cancel")
				.onClick(() => this.close()));

		this.filenameInput?.focus();
		this.filenameInput?.select();
	}

	private async submit(): Promise<void> {
		if (this.isSubmitting) return;
		this.isSubmitting = true;
		try {
			const rawName = this.filenameInput?.value ?? "";
			const filename = normalizeChatFilename(rawName);

			if (!filename) {
				new Notice("Enter a file name.");
				return;
			}

			const filepath = normalizePath(`${FOLDER_NAME}/${filename}`);

			if (
				this.plugin.fileManager.fileExists(filepath) &&
				filepath !== this.chatWindow.savedChatPath
			) {
				new Notice("A file with that name already exists. Choose a different name.");
				return;
			}

			await this.plugin.writeChatToFile(this.chatWindow, filepath);
			new Notice(`Chat saved as: ${filepath}`);
			this.close();
		} finally {
			this.isSubmitting = false;
		}
	}
}
