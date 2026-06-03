import {APP_NAME, ICON_NAME} from "../constants";
import MiniRagPlugin from "../../main";
import {Menu, Notice, TAbstractFile, TFile, TFolder} from "obsidian";

export class MenuManager {
	plugin: MiniRagPlugin;

	constructor(plugin: MiniRagPlugin) {
		this.plugin = plugin;
		this.registerItemsToContextMenuInNotes();
		this.registerItemsToContextMenuInFileNavigator();
	}

	addMenuItemContextFreeChat(menu: Menu) {
		if(this.isModelSelected() && this.plugin.settings.isContextFreeChatsEnabled) {
			menu.addItem((item) => {
				item
					.setTitle(this.getMenuTitleOfItem())
					.setIcon(ICON_NAME)
					.onClick(async () => {
						++this.plugin.contextLoadSeq;
						this.plugin.settings.lastContextPath = null;
						this.plugin.settings.lastContextType = null;
						await this.plugin.saveSettings();

						try {
							await this.plugin.activateViewInWorkspace(this.plugin.app.workspace);
						} catch {
							new Notice('Mini-RAG: could not open the chat panel.');
							return;
						}
						this.plugin.ai.abort();
						this.plugin.loadAI();
						const chatWindow = await this.plugin.getChatWindow();
						chatWindow.resetChat();
					});
			});
		}
	}

	addMenuItemContextSensitiveChat(menu: Menu, context: TAbstractFile) {
		if(this.isModelSelected()) {
			menu.addItem((item) => {
				const filename = this.plugin.fileManager.readFilenameWithoutExtension(context)
				item
					.setTitle(this.getMenuTitleOfItem(filename))
					.setIcon(ICON_NAME)
					.onClick(async () => {
						// Stamp this load attempt; any earlier in-flight handler will see a
						// mismatch after its next await and bail out before touching the UI.
						const seq = ++this.plugin.contextLoadSeq;
						this.plugin.loadContextualizer();
						this.plugin.settings.lastContextPath = context.path;
						this.plugin.settings.lastContextType = context instanceof TFile ? 'file' : 'folder';
						await this.plugin.saveSettings();
						if (seq !== this.plugin.contextLoadSeq) return;

						try {
							await this.plugin.activateViewInWorkspace(this.plugin.app.workspace);
						} catch {
							new Notice('Mini-RAG: could not open the chat panel.');
							return;
						}
						if (seq !== this.plugin.contextLoadSeq) return;

						if (context instanceof TFile) {
							await this.plugin.context.addFileToContext(context);
						} else if (context instanceof TFolder) {
							await this.plugin.context.addFolderToContext(context);
						}
						this.plugin.ai.abort();
						this.plugin.loadAI();
						if (seq !== this.plugin.contextLoadSeq) return;

						const chatWindow = await this.plugin.getChatWindow();
						chatWindow.resetChat(filename);
						chatWindow.setAwaitingResponse(true);
						try {
							await this.plugin.context.buildIndex(this.plugin.ai);
						} catch (e) {
							if (this.plugin.settings.dedicatedEmbeddingEnabled) {
								chatWindow.showIndexError(this.plugin.ai.resolvedEmbeddingModel);
							} else if (/status 501/.test(e instanceof Error ? e.message : String(e))) {
								// Chat model doesn't support embeddings — fall back to full context injection.
								// hasContext() is true so sendTextAsChatMessage will use getRawContext().
							} else {
								const detail = e instanceof Error ? e.message : String(e);
								new Notice(`Mini-RAG: failed to build index — ${detail}`);
							}
						} finally {
							if (seq === this.plugin.contextLoadSeq) {
								chatWindow.setAwaitingResponse(false);
							}
						}
					});
			});
		}
	}

	getMenuTitleOfItem(filename?: string) {
		return `Open ${APP_NAME} chat ${filename ? `(context: "${filename}")` : '(context-free)'}`;
	}

	isModelSelected() {
		return this.plugin.settings.aiModel !== '';
	}

	registerItemsToContextMenuInNotes(){
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("editor-menu", (menu, _, {file}) => {
				if(file) this.addMenuItemContextSensitiveChat(menu, file);
				this.addMenuItemContextFreeChat(menu);
			})
		);
	}

	registerItemsToContextMenuInFileNavigator(){
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder && file.isRoot())) {
					this.addMenuItemContextSensitiveChat(menu, file);
				}
				this.addMenuItemContextFreeChat(menu);
			})
		);
	}
}
