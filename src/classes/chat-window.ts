import {Component, ItemView, Notice, setIcon, WorkspaceLeaf} from "obsidian";
import {clipboard} from "electron";
import {APP_NAME, CSS_CLASS_PREFIX, ICON_NAME, SUPPORT_URL, VIEW_TYPE} from "../constants";
import MiniRagPlugin from "../../main";
import {ChatLoadingAnimation} from "./ui/chat-loading-animation";
import {ChatConversationWindow} from "./ui/chat-conversation-window";
import {ChatButtons} from "./ui/chat-buttons";
import {ChatInput} from "./ui/chat-input";
import {ChatMessages} from "./ui/chat-messages";
import {selectContextMode} from "../prompt";
import {summarizeNotes, SummarizeProgress} from "../summarize";
import {contextCharBudget, ContextWindow, fitNotes, fitNotice, resolveWindow} from "../context-budget";
import {AiProvider} from "../providers/types";

/** How long a window the server reported is trusted before asking again. */
const WINDOW_CACHE_MS = 60_000;

/** The most of a question's window the retrieved excerpts may take; the conversation gets the rest. */
const EXCERPT_SHARE = 0.6;
import {activeProviderConfig} from "../settings";
import {isAbortError} from "../providers/errors";
import {handleIndexBuildError} from "./index-build";

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
	/** The last window a server reported, so each question does not cost a lookup. */
	private windowCache: {ai: AiProvider; tokens: number; at: number} | null = null;
	/** The last "notes left out" line shown for a question, so it is not repeated every turn. */
	private lastContextNotice: string | null = null;
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
			// The window is shared: the question, then excerpts, then as much conversation as fits.
			const window = await this.contextWindow();
			const budgetChars = contextCharBudget(window.tokens, 0);
			let contextBlock: string | null = null;
			switch (selectContextMode(this.plugin.context.hasIndex(), this.plugin.context.hasContext())) {
				case 'rag': {
					const queryEmbedding = await this.plugin.ai.getEmbedding(trimmed);
					if (activeProviderConfig(this.plugin.settings).dedicatedEmbeddingEnabled) {
						const unloaded = await this.plugin.ai.waitForEmbeddingModelUnloaded();
						if (!unloaded) {
							new Notice('Mini-RAG: embedding model did not unload in time — GPU errors may follow.');
						}
					}
					// A share of the window is left for the conversation, so a long chat keeps
					// some memory of itself.
					contextBlock = this.plugin.context.getRelevantContext(
						queryEmbedding,
						this.plugin.settings.ragTopK,
						Math.floor(EXCERPT_SHARE * (budgetChars - trimmed.length)),
					);
					break;
				}
				case 'raw': {
					const fit = fitNotes(this.plugin.context.getContextNotes(), budgetChars - trimmed.length);
					contextBlock = fit.text;
					// The same notes are left out every turn, so say so once, not on each question.
					const notice = fitNotice(fit, window);
					if (notice && notice !== this.lastContextNotice) {
						this.conversationWindow.addContextNote(notice);
						this.lastContextNotice = notice;
					}
					break;
				}
			}
			// The excerpts go as per-turn context rather than being glued onto the question, so the
			// question the model sees — and the one remembered in history — is what the user typed.
			await this.plugin.ai.sendQuestion(trimmed, {
				context: contextBlock || undefined,
				budgetChars,
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

			// An abort means the panel was closed mid-stream — not a user-facing error.
			if (isAbortError(error)) {
				return;
			}

			const detail = this.plugin.ai.formatError(error);
			new Notice(detail.split("\n")[0]);
			this.conversationWindow.addToConversation(detail, true);
		} finally {
			this.setAwaitingResponse(false);
		}
	}

	/**
	 * The whole context, cut at a note boundary to fit the chat model's window when the server says
	 * how big that is, plus what to tell the user about anything left out. `reservedChars` is what
	 * the request carries besides the notes.
	 */
	/**
	 * The chat model's window: what the server reports, or an assumed one when it reports none. A
	 * reported window is trusted for a minute and only for the provider that reported it; an
	 * unreported one is asked about again, since a server may be able to say later.
	 */
	private async contextWindow(): Promise<ContextWindow> {
		const ai = this.plugin.ai;
		const cached = this.windowCache;
		if (cached && cached.ai === ai && Date.now() - cached.at < WINDOW_CACHE_MS) {
			return {tokens: cached.tokens, assumed: false};
		}
		const window = resolveWindow(await ai.contextLength?.());
		this.windowCache = window.assumed ? null : {ai, tokens: window.tokens, at: Date.now()};
		return window;
	}

	async summarizeContext() {
		if (this.isAwaitingResponse) return;

		this.conversationWindow.addToConversation('Summarize', false);
		this.chatMessages.addUserMessage('Summarize');
		this.scrollToEnd();

		this.setAwaitingResponse(true, {showLoader: false});
		const stream = this.conversationWindow.beginStreamingResponse();
		this.chatMessages.beginAssistantMessage();
		// How far a staged run has got, written by its progress callback.
		const staged: {progress: SummarizeProgress | null; note: {update(text: string): void} | null} = {
			progress: null,
			note: null,
		};

		try {
			const window = await this.contextWindow();
			const notes = this.plugin.context.getContextNotes();

			// Each part is its own request outside the conversation; only the summary of the whole
			// streams into the answer, and only it is remembered.
			const {summary, parts} = await summarizeNotes({
				notes,
				windowTokens: window.tokens,
				// The prompt's token count, when the server reports it, sizes the parts that follow.
				complete: async (prompt, request) => {
					let promptTokens: number | undefined;
					const text = await this.plugin.ai.complete(prompt, {
						...request,
						onUsage: usage => {
							promptTokens = usage.promptTokens;
						},
					});
					return {text, promptTokens};
				},
				onProgress: next => {
					staged.progress = next;
					if (!staged.note) {
						staged.note = this.conversationWindow.beginProgressNote('');
						this.buttons.setSummarizeStopping(() => this.plugin.ai.abort());
					}
					staged.note.update(next.done < next.total
						? `Summarizing part ${next.done + 1} of ${next.total}…`
						: `Combining the summaries of ${next.total} parts…`);
				},
				onToken: (_token, fullText) => {
					stream.append(fullText);
					this.chatMessages.setLastAssistantContent(fullText);
					this.scrollToEnd();
				},
			});

			const assumed = window.assumed
				? ` (assumed ${window.tokens.toLocaleString('en-US')}-token context)`
				: '';
			staged.note?.update(
				`Summarized ${notes.length} note${notes.length === 1 ? '' : 's'} in ${parts} parts${assumed}.`,
			);
			this.plugin.ai.remember('Summarize', summary);
			stream.finish();
			this.scrollToEnd();
		} catch (error) {
			stream.remove();
			this.chatMessages.removeLastMessage();
			// Stopped or failed, a staged run says how far it got.
			const {progress, note} = staged;
			if (progress) {
				note?.update(progress.done < progress.total
					? `Stopped at part ${progress.done + 1} of ${progress.total}.`
					: 'Stopped while combining the summaries.');
			}

			if (isAbortError(error)) return;

			const detail = this.plugin.ai.formatError(error);
			new Notice(detail.split('\n')[0]);
			this.conversationWindow.addToConversation(detail, true);
		} finally {
			this.buttons.setSummarizeStopping(null);
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

		this.indexErrorEl = this.chatContainer.createEl('div', {cls: CSS_CLASS_PREFIX + 'index-error'});
		// All DOM listeners for the error panel are scoped to this child component so they
		// are unregistered together when hideIndexError removes the panel.
		this.indexErrorComponent = this.addChild(new Component());

		const header = this.indexErrorEl.createEl('div', {cls: CSS_CLASS_PREFIX + 'brand-header'});
		const iconEl = header.createEl('span', {cls: CSS_CLASS_PREFIX + 'brand-icon'});
		setIcon(iconEl, ICON_NAME);
		header.createEl('span', {text: APP_NAME});

		if (modelName === '') {
			this.renderChooseModelHelp(this.indexErrorEl);
		} else {
			this.renderInstallHelp(this.indexErrorEl, modelName, this.indexErrorComponent);
		}

		const refreshBtn = this.indexErrorEl.createEl('button', {cls: CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'refresh-button'});
		setIcon(refreshBtn.createSpan(), 'refresh-cw');
		refreshBtn.createSpan({text: 'Refresh'});
		refreshBtn.setAttr('aria-label', 'Refresh');
		this.indexErrorComponent.registerDomEvent(refreshBtn, 'click', () => void this.retryIndex());

		const support = this.indexErrorEl.createEl('p', {cls: CSS_CLASS_PREFIX + 'index-error-support'});
		support.appendText('If problems persist, check the settings for Mini-RAG or ');
		support.createEl('a', {text: 'contact support', href: SUPPORT_URL});
		support.appendText('.');
	}

	/** No model chosen: nothing to install, so the fix is choosing one in the settings. */
	private renderChooseModelHelp(panel: HTMLElement) {
		const which = activeProviderConfig(this.plugin.settings).dedicatedEmbeddingEnabled
			? 'an Embedding Model'
			: 'a Chat Model';
		panel.createEl('p', {
			text: 'Mini-RAG has no model chosen to read your notes with. Please:',
			cls: CSS_CLASS_PREFIX + 'index-error-desc',
		});
		const steps = panel.createEl('ol', {cls: CSS_CLASS_PREFIX + 'index-error-steps'});
		steps.createEl('li', {text: `Choose ${which} in Mini-RAG's settings.`});
		steps.createEl('li', {text: 'Click "Refresh" below.'});
	}

	/**
	 * A model that is not there: what was expected, then two steps — run the command, then
	 * Refresh. The words come from the active provider: `ollama pull`, or a second llama-server.
	 */
	private renderInstallHelp(panel: HTMLElement, modelName: string, component: Component) {
		const hint = this.plugin.ai.embeddingInstallHint(modelName);
		panel.createEl('p', {text: `${hint.summary} Please:`, cls: CSS_CLASS_PREFIX + 'index-error-desc'});
		const steps = panel.createEl('ol', {cls: CSS_CLASS_PREFIX + 'index-error-steps'});

		const command = hint.command;
		if (command) {
			const runStep = steps.createEl('li');
			runStep.createSpan({text: `Run this command${hint.commandNote ? ` (${hint.commandNote})` : ''}:`});
			const cmdRow = runStep.createEl('div', {cls: CSS_CLASS_PREFIX + 'copy-command'});
			cmdRow.createEl('code', {text: command});
			const copyBtn = cmdRow.createEl('button', {cls: 'clickable-icon ' + CSS_CLASS_PREFIX + 'icon-button ' + CSS_CLASS_PREFIX + 'copy-button'});
			setIcon(copyBtn, 'copy');
			copyBtn.setAttr('aria-label', 'Copy');
				component.registerDomEvent(copyBtn, 'click', () => {
				try {
					clipboard.writeText(command);
					setIcon(copyBtn, 'check');
					copyBtn.setAttr('aria-label', 'Copied!');
					window.setTimeout(() => {
						setIcon(copyBtn, 'copy');
						copyBtn.setAttr('aria-label', 'Copy');
					}, 2000);
				} catch {
					new Notice('Could not copy to clipboard.');
				}
			});
		}
		steps.createEl('li', {text: 'Click "Refresh" below.'});
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
		} catch (error) {
			// The same decision as any other build: a panel, a fallback, or a notice.
			handleIndexBuildError(error, this.plugin.indexBuildErrorDeps(this));
		} finally {
			this.setAwaitingResponse(false);
		}
	}

	/** The chat model or provider changed in the settings; see ChatConversationWindow.modelChanged. */
	modelChanged() {
		this.conversationWindow?.modelChanged();
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
