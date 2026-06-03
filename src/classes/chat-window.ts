import {Component, ItemView, Notice, setIcon, WorkspaceLeaf} from "obsidian";
import {clipboard} from "electron";
import {APP_NAME, CSS_CLASS_PREFIX, ICON_NAME, VIEW_TYPE} from "../constants";
import MiniRagPlugin from "../../main";
import {ChatLoadingAnimation} from "./ui/chat-loading-animation";
import {ChatConversationWindow} from "./ui/chat-conversation-window";
import {ChatButtons} from "./ui/chat-buttons";
import {ChatInput} from "./ui/chat-input";
import {ChatMessages} from "./ui/chat-messages";
import {formatOllamaError} from "../utils";

export class ChatWindow extends ItemView {
	plugin: MiniRagPlugin;
	buttons!: ChatButtons;
	loader!: ChatLoadingAnimation;
	conversationWindow!: ChatConversationWindow;
	input!: ChatInput;
	chatContainer!: Element;
	chatStarted!: Date;
	chatMessages!: ChatMessages;
	inputWrapper!: HTMLDivElement;
	chatSubject?: string;
	savedChatPath: string | null = null;
	private isAwaitingResponse = false;
	private indexErrorEl: HTMLElement | null = null;
	private indexErrorComponent: Component | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MiniRagPlugin) {
		super(leaf);
		this.icon = ICON_NAME;
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return APP_NAME;
	}

	setAwaitingResponse(isAwaiting: boolean, options?: { showLoader?: boolean }) {
		this.isAwaitingResponse = isAwaiting;
		if (isAwaiting) {
			if (options?.showLoader !== false) {
				this.loader.show();
			} else {
				this.loader.hide();
			}
			this.buttons.setSendEnabled(false);
			this.buttons.setSaveEnabled(false);
			this.buttons.setSummarizeEnabled(false);
			this.input.setSendEnabled(false);
			this.conversationWindow.setModelSelectorEnabled(false);
		} else {
			this.loader.hide();
			this.buttons.setSendEnabled(true);
			this.buttons.setSaveEnabled(true);
			this.buttons.setSummarizeEnabled(true);
			this.input.setSendEnabled(true);
			this.conversationWindow.setModelSelectorEnabled(true);
		}
	}

	scrollToEnd() {
		const el = this.conversationWindow.htmlElement;
		el.scrollTop = el.scrollHeight;
	}

	async sendTextAsChatMessage(text: string) {
		if (this.isAwaitingResponse) {
			return;
		}

		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}

		this.conversationWindow.addToConversation(trimmed, false);
		this.chatMessages.addUserMessage(trimmed);
		this.scrollToEnd();

		this.setAwaitingResponse(true, {showLoader: false});
		const stream = this.conversationWindow.beginStreamingResponse();
		this.chatMessages.beginAssistantMessage();

		try {
			let prompt = trimmed;
			if (this.plugin.context.hasIndex()) {
				const queryEmbedding = await this.plugin.ai.getEmbedding(trimmed);
				if (this.plugin.settings.dedicatedEmbeddingEnabled) {
					const unloaded = await this.plugin.ai.waitForEmbeddingModelUnloaded();
					if (!unloaded) {
						new Notice('Mini-RAG: embedding model did not unload in time — GPU errors may follow.');
					}
				}
				const relevantContext = this.plugin.context.getRelevantContext(
					queryEmbedding,
					this.plugin.settings.ragTopK,
				);
				if (relevantContext) {
					prompt = relevantContext + '\n\nQuestion: ' + trimmed;
				}
			} else if (this.plugin.context.hasContext()) {
				const fullContext = this.plugin.context.getRawContext();
				if (fullContext) {
					prompt = fullContext + '\n\nQuestion: ' + trimmed;
				}
			}

			await this.plugin.ai.sendQuestion(prompt, {
				onToken: (_token, fullText) => {
					stream.append(fullText);
					this.chatMessages.setLastAssistantContent(fullText);
					this.scrollToEnd();
				},
			});

			stream.finish();
			this.scrollToEnd();
		} catch (error) {
			stream.remove();
			this.chatMessages.removeLastMessage();

			// AbortError means the panel was closed mid-stream — not a user-facing error.
			if (error instanceof DOMException && error.name === 'AbortError') {
				return;
			}

			const detail = formatOllamaError(error);
			new Notice(detail.split("\n")[0]);
			this.conversationWindow.addToConversation(detail, true);
		} finally {
			this.setAwaitingResponse(false);
		}
	}

	async summarizeContext() {
		if (this.isAwaitingResponse) return;

		this.conversationWindow.addToConversation('Summarize', false);
		this.chatMessages.addUserMessage('Summarize');
		this.scrollToEnd();

		this.setAwaitingResponse(true, {showLoader: false});
		const stream = this.conversationWindow.beginStreamingResponse();
		this.chatMessages.beginAssistantMessage();

		try {
			const allContext = this.plugin.context.getAllContext() || this.plugin.context.getRawContext();
			const prompt = allContext
				? `Please summarize the following content:\n\n${allContext}`
				: 'Please summarize.';

			await this.plugin.ai.sendQuestion(prompt, {
				onToken: (_token, fullText) => {
					stream.append(fullText);
					this.chatMessages.setLastAssistantContent(fullText);
					this.scrollToEnd();
				},
			});

			stream.finish();
			this.scrollToEnd();
		} catch (error) {
			stream.remove();
			this.chatMessages.removeLastMessage();

			if (error instanceof DOMException && error.name === 'AbortError') return;

			const detail = formatOllamaError(error);
			new Notice(detail.split('\n')[0]);
			this.conversationWindow.addToConversation(detail, true);
		} finally {
			this.setAwaitingResponse(false);
		}
	}

	async sendInputAsChatMessage() {
		if (!this.input.canSend()) {
			return;
		}

		const inputText = this.input.getValue();
		if (!inputText.trim()) {
			return;
		}
		this.input.clear();
		await this.sendTextAsChatMessage(inputText);
	}

	initInputArea() {
		this.inputWrapper = this.chatContainer.createEl("div", {cls: CSS_CLASS_PREFIX + "input-area"});
		this.inputWrapper.createEl('p', { text: 'Ask a question…', cls: CSS_CLASS_PREFIX + "input-label" });
		this.input = new ChatInput(this);
		this.input.init();
		this.buttons = new ChatButtons(this);
		this.buttons.init();
	}

	showIndexError(modelName: string) {
		// Remove any existing error panel first (prevents stacking on repeated failures).
		this.indexErrorEl?.remove();
		this.indexErrorEl = null;
		if (this.indexErrorComponent) {
			this.removeChild(this.indexErrorComponent);
			this.indexErrorComponent = null;
		}

		this.conversationWindow.headerEl.classList.add("hidden");
		this.conversationWindow.htmlElement.classList.add("hidden");
		this.inputWrapper.classList.add("hidden");

		const cmd = `ollama pull ${modelName}`;
		this.indexErrorEl = this.chatContainer.createEl('div', {cls: CSS_CLASS_PREFIX + 'index-error'});
		// All DOM listeners for the error panel are scoped to this child component so they
		// are unregistered together when hideIndexError removes the panel.
		this.indexErrorComponent = this.addChild(new Component());

		const header = this.indexErrorEl.createEl('div', {cls: CSS_CLASS_PREFIX + 'brand-header'});
		const iconEl = header.createEl('span', {cls: CSS_CLASS_PREFIX + 'brand-icon'});
		setIcon(iconEl, ICON_NAME);
		header.createEl('span', {text: APP_NAME});

		this.indexErrorEl.createEl('h3', {text: 'Embedding model not found', cls: CSS_CLASS_PREFIX + 'index-error-title'});
		this.indexErrorEl.createEl('p', {
			text: `Mini-RAG needs "${modelName}" to create embeddings. To install it:`,
			cls: CSS_CLASS_PREFIX + 'index-error-desc',
		});
		const steps = this.indexErrorEl.createEl('ol', {cls: CSS_CLASS_PREFIX + 'index-error-steps'});

		const step1Inner = steps.createEl('li').createEl('div', {cls: CSS_CLASS_PREFIX + 'index-error-step'});
		step1Inner.createSpan({text: 'Copy the pull command (below)'});
		const copyBtnInline = step1Inner.createEl('button', {cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'copy-button'});
		setIcon(copyBtnInline, 'copy');
		copyBtnInline.setAttr('aria-label', 'Copy');
		copyBtnInline.setAttr('title', 'Copy');
		this.indexErrorComponent.registerDomEvent(copyBtnInline, 'click', () => {
			try {
				clipboard.writeText(cmd);
				setIcon(copyBtnInline, 'check');
				copyBtnInline.setAttr('aria-label', 'Copied!');
				setTimeout(() => {
					setIcon(copyBtnInline, 'copy');
					copyBtnInline.setAttr('aria-label', 'Copy');
				}, 2000);
			} catch {
				new Notice('Could not copy to clipboard.');
			}
		});

		steps.createEl('li', {text: 'Run it in your terminal'});

		const step3Inner = steps.createEl('li').createEl('div', {cls: CSS_CLASS_PREFIX + 'index-error-step'});
		step3Inner.createSpan({text: 'Click Refresh when it finishes'});
		const refreshBtnInline = step3Inner.createEl('button', {cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'refresh-button'});
		setIcon(refreshBtnInline, 'refresh-cw');
		refreshBtnInline.setAttr('aria-label', 'Refresh');
		refreshBtnInline.setAttr('title', 'Refresh');
		this.indexErrorComponent.registerDomEvent(refreshBtnInline, 'click', () => void this.retryIndex());

		const cmdRow = this.indexErrorEl.createEl('div', {cls: CSS_CLASS_PREFIX + 'copy-command'});
		cmdRow.createEl('code', {text: cmd});
		const copyBtn = cmdRow.createEl('button', {cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'copy-button'});
		setIcon(copyBtn, 'copy');
		copyBtn.setAttr('aria-label', 'Copy');
		copyBtn.setAttr('title', 'Copy');
		this.indexErrorComponent.registerDomEvent(copyBtn, 'click', () => {
			try {
				clipboard.writeText(cmd);
				setIcon(copyBtn, 'check');
				copyBtn.setAttr('aria-label', 'Copied!');
				setTimeout(() => {
					setIcon(copyBtn, 'copy');
					copyBtn.setAttr('aria-label', 'Copy');
				}, 2000);
			} catch {
				new Notice('Could not copy to clipboard.');
			}
		});

		const refreshBtn = this.indexErrorEl.createEl('button', {cls: CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'refresh-button'});
		setIcon(refreshBtn.createSpan(), 'refresh-cw');
		refreshBtn.createSpan({text: 'Refresh'});
		this.indexErrorComponent.registerDomEvent(refreshBtn, 'click', () => void this.retryIndex());
	}

	private hideIndexError() {
		this.indexErrorEl?.remove();
		this.indexErrorEl = null;
		if (this.indexErrorComponent) {
			this.removeChild(this.indexErrorComponent);
			this.indexErrorComponent = null;
		}
		this.conversationWindow.headerEl.classList.remove("hidden");
		this.conversationWindow.htmlElement.classList.remove("hidden");
		this.inputWrapper.classList.remove("hidden");
	}

	private async retryIndex() {
		this.hideIndexError();
		this.setAwaitingResponse(true);
		try {
			await this.plugin.context.buildIndex(this.plugin.ai);
		} catch {
			this.showIndexError(this.plugin.ai.resolvedEmbeddingModel);
		} finally {
			this.setAwaitingResponse(false);
		}
	}

	resetChat(chatSubject?: string) {
		this.hideIndexError();
		this.chatMessages.clear();
		this.chatStarted = new Date();
		this.chatSubject = chatSubject;
		this.savedChatPath = null;
		this.conversationWindow.clear();
		this.conversationWindow.addConvoHeading(chatSubject);
		if (chatSubject !== undefined) {
			this.buttons.showSummarizeButton();
		} else {
			this.buttons.hideSummarizeButton();
		}
		this.input?.focusIfActiveView();
	}

	async onOpen() {
		await super.onOpen();
		this.chatMessages = new ChatMessages();
		this.chatStarted = new Date();
		this.chatContainer = this.contentEl;
		this.chatContainer.classList.add(CSS_CLASS_PREFIX + "chat-container");
		this.conversationWindow = new ChatConversationWindow(this.plugin, this.chatContainer, this);
		this.loader = new ChatLoadingAnimation(this.chatContainer);
		this.initInputArea();
		this.setAwaitingResponse(false);
		this.input.focusIfActiveView();
	}

	async onClose() {
		this.plugin.ai.abort();
		await super.onClose();
	}
}
