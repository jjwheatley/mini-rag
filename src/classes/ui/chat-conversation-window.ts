import {Component, MarkdownRenderer, Notice, setIcon} from "obsidian";
import {clipboard} from "electron";
import MiniRagPlugin from "../../../main";
import {APP_NAME, CSS_CLASS_PREFIX, ICON_NAME} from "../../constants";

export class ChatConversationWindow {
	headerEl: HTMLDivElement;
	htmlElement: HTMLDivElement;
	plugin: MiniRagPlugin;
	// Owns the lifecycle of markdown embeds; tied to the ChatWindow so they survive chat resets.
	private renderComponent: Component;
	// Owns per-message click listeners; replaced on clear() so stale listeners don't accumulate.
	private convoComponent: Component;

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

		this.headerEl.createEl('h3', {text: 'Chat with ' + this.plugin.getModelUserFriendlyName()});
		this.headerEl.createEl("div", {text: chatSubject ? 'Context: ' + chatSubject : 'Context-Free'});
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
