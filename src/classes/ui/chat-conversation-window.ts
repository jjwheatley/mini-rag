import {Component, MarkdownRenderer, Menu, Notice, setIcon} from "obsidian";
import {clipboard} from "electron";
import MiniRagPlugin from "../../../main";
import {activeProviderConfig} from "../../settings";
import {APP_NAME, CSS_CLASS_PREFIX, ICON_NAME} from "../../constants";
import {AiProvider} from "../../providers/types";
import {openFundingLink, SUPPORT_TITLE, supportTitle} from "../../support";

export class ChatConversationWindow {
	headerEl: HTMLDivElement;
	htmlElement: HTMLDivElement;
	plugin: MiniRagPlugin;
	// Owns the lifecycle of Markdown embeds; tied to the ChatWindow so they survive chat resets.
	private readonly renderComponent: Component;
	// Owns per-message click listeners; replaced on clear() so stale listeners don't accumulate.
	private convoComponent: Component;
	private cachedModels: string[] = [];
	/** The provider the cached list came from: a failed refresh never falls back on another's. */
	private cachedFor: AiProvider | null = null;
	/** Whether the last attempt to list models failed, leaving nothing to offer. */
	private modelListFailed = false;
	private modelNameEl: HTMLElement | null = null;
	private modelChevronBtn: HTMLButtonElement | null = null;

	constructor(plugin: MiniRagPlugin, parent: Element, renderComponent: Component) {
		this.plugin = plugin;
		this.renderComponent = renderComponent;
		this.convoComponent = renderComponent.addChild(new Component());
		this.headerEl = parent.createEl("div", {cls: CSS_CLASS_PREFIX + 'chat-header'});
		this.htmlElement = parent.createEl("div", {cls: CSS_CLASS_PREFIX + 'conversation'});
		this.addConvoHeading();
	}

	addConvoHeading(chatSubject?: string) {
		this.headerEl.empty();

		const header = this.headerEl.createEl("div", {cls: CSS_CLASS_PREFIX + 'brand-header'});
		const iconEl = header.createEl('span', {cls: CSS_CLASS_PREFIX + 'brand-icon'});
		setIcon(iconEl, ICON_NAME);
		header.createEl('span', {text: APP_NAME});
		this.addSupportButton(header);

		const modelRow = this.headerEl.createEl('div', {cls: CSS_CLASS_PREFIX + 'model-row'});
		this.modelNameEl = modelRow.createEl('h3', {
			text: 'Chat with ' + this.plugin.getModelUserFriendlyName(),
		});

		const chevron = modelRow.createEl('button', {
			cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button',
		});
		this.modelChevronBtn = chevron;
		setIcon(chevron, 'chevron-down');
		chevron.setAttr('aria-label', 'Change model');
		chevron.addEventListener('click', () => void this.showModelMenu(chevron));

		this.headerEl.createEl("div", {text: chatSubject ? 'Context: ' + chatSubject : 'Context-Free'});

		void this.fetchModels();
	}

	/**
	 * A heart at the end of the header, offering the manifest's funding links. It opens nothing until
	 * clicked; with one link there is nothing to choose between, so that opens straight away.
	 */
	private addSupportButton(header: HTMLElement) {
		const links = this.plugin.fundingLinks();
		if (links.length === 0) return;
		const button = header.createEl('button', {
			cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'support-button',
		});
		setIcon(button, 'heart');
		button.setAttr('aria-label', SUPPORT_TITLE);
		button.addEventListener('click', () => {
			if (links.length === 1) {
				openFundingLink(links[0]);
				return;
			}
			const menu = new Menu();
			// Obsidian's menus have no title of their own; a label entry serves as one. (A disabled
			// entry looked the part, but was too faint to read.) Its heart follows the text, as in the
			// settings banner, rather than taking the icon's place on the left.
			menu.addItem(item => item.setTitle(supportTitle()).setIsLabel(true));
			menu.addSeparator();
			for (const link of links) {
				menu.addItem(item => item.setTitle(link.name).setIcon('external-link').onClick(() => openFundingLink(link)));
			}
			const rect = button.getBoundingClientRect();
			menu.showAtPosition({x: rect.left, y: rect.bottom + 4});
		});
	}

	private async fetchModels() {
		const ai = this.plugin.ai;
		try {
			this.cachedModels = await ai.getModelList();
			this.cachedFor = ai;
			this.modelListFailed = false;
			// Where the server decides the model, it has now said which: name that one.
			if (this.modelNameEl) {
				this.modelNameEl.textContent = 'Chat with ' + this.plugin.getModelUserFriendlyName();
			}
		} catch {
			// Unreachable: keep this provider's last list, but never one from the provider before.
			if (this.cachedFor !== ai) {
				this.cachedModels = [];
				this.cachedFor = ai;
			}
			this.modelListFailed = this.cachedModels.length === 0;
		}
	}

	private async showModelMenu(anchor: HTMLElement) {
		await this.fetchModels();

		const menu = new Menu();
		if (this.cachedModels.length === 0) {
			const title = this.modelListFailed ? 'Could not load models' : 'No models found';
			menu.addItem(item => item.setTitle(title).setDisabled(true));
		} else {
			for (const model of this.cachedModels) {
				menu.addItem(item => {
					item.setTitle(model);
					if (model === activeProviderConfig(this.plugin.settings).chatModel) item.setIcon('check');
					item.onClick(() => {
						activeProviderConfig(this.plugin.settings).chatModel = model;
						void this.plugin.saveSettings();
						this.plugin.ai.clearContext();
						this.showModelSwitch();
					});
				});
			}
		}

		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({x: rect.left, y: rect.bottom + 4});
	}

	/**
	 * The model or provider was changed in the settings rather than from this pane's menu: show the
	 * new model, mark the switch, and list the models afresh, since they may be another provider's.
	 */
	modelChanged() {
		this.showModelSwitch();
		this.cachedModels = [];
		this.cachedFor = null;
		void this.fetchModels();
	}

	/** Names the model now in use in the heading, and marks the switch in the transcript. */
	private showModelSwitch() {
		if (this.modelNameEl) {
			this.modelNameEl.textContent = 'Chat with ' + this.plugin.getModelUserFriendlyName();
		}
		this.addModelSwitchDivider();
	}

	addModelSwitchDivider() {
		const el = this.htmlElement.createEl('div', {cls: CSS_CLASS_PREFIX + 'model-switch-divider'});
		el.createEl('span', {cls: CSS_CLASS_PREFIX + 'model-switch-line'});
		el.createEl('span', {
			text: 'switched to ' + this.plugin.getModelUserFriendlyName(),
			cls: CSS_CLASS_PREFIX + 'model-switch-label',
		});
		el.createEl('span', {cls: CSS_CLASS_PREFIX + 'model-switch-line'});
	}

	/**
	 * A quiet line about the request itself — say, that some notes did not fit. Not a message: it
	 * is not copied on click or saved with the chat. It goes above an answer still being written,
	 * since that is the answer it describes.
	 */
	addContextNote(text: string): HTMLElement {
		const note = this.htmlElement.createEl('div', {text, cls: CSS_CLASS_PREFIX + 'context-note'});
		const streaming = this.htmlElement.querySelector(`.${CSS_CLASS_PREFIX}convo-box-streaming`);
		streaming?.before(note);
		return note;
	}

	/** A context note that is rewritten as work progresses: "Summarizing part 3 of 16…". */
	beginProgressNote(text: string): {update(text: string): void} {
		const note = this.addContextNote(text);
		return {update: (next: string) => note.setText(next)};
	}

	setModelSelectorEnabled(enabled: boolean) {
		if (this.modelChevronBtn) this.modelChevronBtn.disabled = !enabled;
	}

	addToConversation(text: string, isResponse: boolean) {
		const element = this.createConvoBoxElement(() => text, isResponse);
		if (isResponse) {
			// Empty source path is intentional — AI responses should not resolve wikilinks into vault files.
			void MarkdownRenderer.render(this.plugin.app, text, element, '', this.renderComponent);
		} else {
			element.setText(text);
		}
	}

	beginStreamingResponse() {
		let streamedText = '';
		// Pass a getter so the click handler always reads the final value of streamedText, not the empty string at creation time.
		const element = this.createConvoBoxElement(() => streamedText, true, true);
		return {
			append: (fullText: string) => {
				streamedText = fullText;
				element.setText(fullText);
			},
			finish: () => {
				element.removeClass(CSS_CLASS_PREFIX + "convo-box-streaming");
				element.empty();
				// Empty source path is intentional — see addToConversation.
				void MarkdownRenderer.render(this.plugin.app, streamedText, element, '', this.renderComponent);
			},
			remove: () => element.remove(),
		};
	}

	private createConvoBoxElement(getText: () => string, isResponse: boolean, isStreaming = false) {
		const classes = [
			CSS_CLASS_PREFIX + "convo-box",
			isResponse ? CSS_CLASS_PREFIX + "response" : CSS_CLASS_PREFIX + "query",
		];
		if (isStreaming) {
			classes.push(CSS_CLASS_PREFIX + "convo-box-streaming");
		}

		const element = this.htmlElement.createEl("div", {cls: classes.join(" ")});
		this.convoComponent.registerDomEvent(element, "click", () => {
			try {
				clipboard.writeText(getText());
				new Notice("Message copied");
			} catch {
				new Notice("Could not copy to clipboard.");
			}
		});

		return element;
	}

	clear() {
		this.htmlElement.empty();
		this.renderComponent.removeChild(this.convoComponent);
		this.convoComponent = this.renderComponent.addChild(new Component());
	}
}
