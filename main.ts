import {normalizePath, Notice, Plugin, Workspace, WorkspaceLeaf} from 'obsidian';
import {SettingTab} from "./src/classes/settings-tab";
import {ChatWindow} from "./src/classes/chat-window";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {PluginSettings} from "./src/types";
import {FOLDER_NAME, VIEW_TYPE} from "./src/constants";
import {OllamaWrapper} from "./src/classes/ollama-wrapper";
import {FileManager} from "./src/classes/file-manager";
import {buildChatSaveFilename, firstToUpper, formatChatAsMarkdown} from "./src/utils";
import {Contextualizer} from "./src/classes/contextualizer";
import {MenuManager} from "./src/classes/menu-manager";
import {SaveChatAsModal} from "./src/classes/ui/save-chat-as-modal";

export default class MiniRagPlugin extends Plugin {
	ai: OllamaWrapper;
	menu: MenuManager;
	context: Contextualizer;
	settings: PluginSettings;
	fileManager: FileManager;
	contextLoadSeq = 0;

	async onload() {
		await this.loadSettings();
		this.loadFileManager();
		this.loadContextualizer();
		this.loadAI();
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new ChatWindow(leaf, this));
		this.loadMenu();
		this.addCommand({
			id: 'open-chat',
			name: 'Open chat panel',
			callback: () => { void this.activateViewInWorkspace(this.app.workspace); },
		});
		this.app.workspace.onLayoutReady(() => { void this.replayContextInit(); });
	}

	private async replayContextInit(): Promise<void> {
		const seq = ++this.contextLoadSeq;
		const {lastContextPath, lastContextType} = this.settings;

		if (!lastContextPath || !lastContextType) return;

		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length === 0) {
			return;
		}

		const chatWindow = leaves[0].view;
		if (!(chatWindow instanceof ChatWindow)) {
			return;
		}

		if (lastContextType === 'file') {
			const file = this.app.vault.getFileByPath(lastContextPath);
			if (!file) {
				new Notice(`Mini-RAG: context file not found — "${lastContextPath}"`);
				return;
			}
			await this.context.addFileToContext(file);
			chatWindow.resetChat(file.basename);
		} else {
			const folder = this.app.vault.getFolderByPath(lastContextPath);
			if (!folder) {
				new Notice(`Mini-RAG: context folder not found — "${lastContextPath}"`);
				return;
			}
			await this.context.addFolderToContext(folder);
			chatWindow.resetChat(folder.name);
		}

		if (seq !== this.contextLoadSeq) return;

		chatWindow.setAwaitingResponse(true);
		try {
			await this.context.buildIndex(this.ai);
			if (seq !== this.contextLoadSeq) return;
		} catch {
			if (seq === this.contextLoadSeq) {
				if (this.settings.dedicatedEmbeddingEnabled) {
					chatWindow.showIndexError(this.ai.resolvedEmbeddingModel);
				} else {
					new Notice('Mini-RAG: failed to build the search index. Check that Ollama is running.');
				}
			}
		} finally {
			if (seq === this.contextLoadSeq) {
				chatWindow.setAwaitingResponse(false);
			}
		}
	}

	onunload() {
		this.ai?.abort();
	}

	async getChatWindow(): Promise<ChatWindow> {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];

		if (!leaf) { // No existing leaf — open one
			leaf = await this.activateViewInWorkspace(this.app.workspace);
		}

		const view = leaf.view;
		if (!(view instanceof ChatWindow)) {
			throw new Error('Mini-RAG: unexpected view type on the chat leaf.');
		}
		return view;
	}

	async activateViewInWorkspace(workspace: Workspace): Promise<WorkspaceLeaf> {
		let leaf: WorkspaceLeaf;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length === 0) { // View isn't found in workspace, create in sidebar as new leaf
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) {
				throw new Error("Mini-RAG: could not open a panel in the right sidebar.");
			}
			leaf = rightLeaf;
			await leaf.setViewState({type: VIEW_TYPE, active: true});
		} else { // A leaf with our view already exists, use it
			leaf = leaves[0];
		}
		await workspace.revealLeaf(leaf);

		return leaf;
	}

	getModelUserFriendlyName(){
		if (!this.settings.aiModel) {
			return 'your model';
		}
		const colonIdx = this.settings.aiModel.indexOf(':');
		const nameBeforeColon = colonIdx === -1 ? this.settings.aiModel : this.settings.aiModel.slice(0, colonIdx);
		return firstToUpper(nameBeforeColon);
	}

	loadAI(){
		this.ai = new OllamaWrapper(this);
	}

	loadContextualizer(){
		this.context = new Contextualizer(this);
	}

	loadFileManager(){
		this.fileManager = new FileManager(this.app.vault);
	}

	loadMenu(){
		this.menu = new MenuManager(this);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async ensureChatFolder(): Promise<void> {
		if (!this.fileManager.isFolderPath(FOLDER_NAME)) {
			await this.fileManager.createFolder(FOLDER_NAME);
		}
	}

	async writeChatToFile(chatWindow: ChatWindow, filepath: string): Promise<void> {
		const content = formatChatAsMarkdown(chatWindow.chatMessages.get(), {
			model: this.settings.aiModel,
			modelDisplay: this.getModelUserFriendlyName(),
			started: chatWindow.chatStarted,
			updated: new Date(),
			contextSubject: chatWindow.chatSubject,
		});

		await this.fileManager.updateFile(filepath, content);
		chatWindow.savedChatPath = filepath;
	}

	async saveChat(chatWindow: ChatWindow, saveAs = false) {
		if (chatWindow.chatMessages.get().length === 0) {
			new Notice('Nothing to save — start a conversation first.');
			return;
		}

		try {
			await this.ensureChatFolder();

			if (saveAs) {
				new SaveChatAsModal(this.app, this, chatWindow).open();
				return;
			}

			const hadSavedPath = chatWindow.savedChatPath !== null;
			let filepath = chatWindow.savedChatPath;

			if (!filepath) {
				const filename = buildChatSaveFilename(
					chatWindow.chatStarted,
					this.getModelUserFriendlyName()
				);
				filepath = normalizePath(`${FOLDER_NAME}/${filename}`);
			}

			await this.writeChatToFile(chatWindow, filepath);

			if (!hadSavedPath) {
				new Notice(`Chat saved: ${filepath}`);
			} else {
				new Notice(`Chat updated: ${filepath}`);
			}
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			new Notice(`Mini-RAG: failed to save chat. ${detail}`);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
