import {APP_NAME, ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {ChatWindow} from "./chat-window";
import {Menu, TAbstractFile, TFile, TFolder} from "obsidian";

export class MenuManager {
	plugin: OllamaPlugin;

	constructor(plugin: OllamaPlugin) {
		this.plugin = plugin;
		this.registerChatWindow();
		this.registerItemsToContextMenuInNotes();// Register menu item for right-click "context" menu, within the file view
		this.registerItemsToContextMenuInFileNavigator();// Register menu item for a triple-dot file menu & right-click menu within the left sidebar
	}

	addMenuItemContextFreeChat(menu: Menu){
		if(this.isModelSelected() && this.plugin.settings.isContextFreeChatsEnabled) {
			menu.addItem((item) => {
				item
					.setTitle(this.getMenuTitleOfItem())
					.setIcon(ICON_NAME)
					.onClick(async () => {
						await this.plugin.activateViewInWorkspace(this.plugin.app.workspace);
						//Remove existing context and chat history
						this.plugin.loadAI()
						this.plugin.ui.resetChat()
					});
			});
		}
	}

	addMenuItemContextSensitiveChat(menu: Menu, context: TAbstractFile){
		if(this.isModelSelected()) {
			menu.addItem((item) => {
				const filename = this.plugin.fileManager.readFilenameWithoutExtension(context)
				item
					.setTitle(this.getMenuTitleOfItem(filename))
					.setIcon(ICON_NAME)
					.onClick(async () => {
						await this.plugin.activateViewInWorkspace(this.plugin.app.workspace);
						//Remove existing context and chat history
						this.plugin.loadContextualizer();
						if (context instanceof TFile) {
							await this.plugin.context.addFileToContext(context);
						} else if (context instanceof TFolder) {
							await this.plugin.context.addFolderToContext(context);
						}
						this.plugin.loadAI(this.plugin.context.getContextAsText());
						this.plugin.ui.resetChat(filename);
					});
			});
		}
	}

	getMenuTitleOfItem(filename?: string){
		return "Open " + APP_NAME + " chat " + (filename? "(context: \"" + filename + "\")" :"(context-free)");
	}

	isModelSelected() {
		return this.plugin.settings.aiModel !== '';
	}

	registerChatWindow() {
		this.plugin.registerView(
			VIEW_TYPE,
			(leaf) => {
				this.plugin.ui = new ChatWindow(leaf, this.plugin);
				return this.plugin.ui;
			}
		);
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
				this.addMenuItemContextSensitiveChat(menu, file);
				this.addMenuItemContextFreeChat(menu);
			})
		);
	}
}
