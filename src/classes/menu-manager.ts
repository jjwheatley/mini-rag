import {APP_NAME, ICON_NAME, VIEW_TYPE} from "../constants";
import OllamaPlugin from "../../main";
import {ChatWindow} from "./chat-window";
import {Menu, TAbstractFile, TFolder} from "obsidian";

export class MenuManager {
	plugin: OllamaPlugin;

	constructor(plugin: OllamaPlugin) {
		this.plugin = plugin;
		this.registerChatWindow()
		this.registerItemsToContextMenuInFileNavigator()// Register menu item for a triple-dot file menu & right-click menu within the left sidebar
		this.registerItemsToContextMenuInNotes()// Register menu item for right-click "context" menu, within the file view
	}

	registerItemsToContextMenuInFileNavigator(){
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-menu", (menu, file) => {
				this.addMenuItemContextSensitiveChat(menu, file);
				this.addMenuItemContextFreeChat(menu)
			})
		);
	}

	registerItemsToContextMenuInNotes(){
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("editor-menu", (menu, _, {file}) => {
				if(file) this.addMenuItemContextSensitiveChat(menu, file)
				this.addMenuItemContextFreeChat(menu)
			})
		);
	}

	registerChatWindow(): void {
		this.plugin.registerView(
			VIEW_TYPE,
			(leaf) => {
				this.plugin.ui = new ChatWindow(leaf, this.plugin)
				return this.plugin.ui
			}
		);
	}

	addMenuItemContextFreeChat(menu: Menu){
		if(this.plugin.settings.isContextFreeChatsEnabled) {
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
		menu.addItem((item) => {
			const filename = this.plugin.fileManager.readFilenameWithoutExtension(context)
			item
				.setTitle(this.getMenuTitleOfItem(filename))
				.setIcon(ICON_NAME)
				.onClick(async () => {
					await this.plugin.activateViewInWorkspace(this.plugin.app.workspace);
					//Remove existing context and chat history
					this.plugin.loadContextualizer()
					if(this.plugin.fileManager.isFile(context)){
						await this.plugin.context.addFileToContext(context)
					}else if(this.plugin.fileManager.isFolder(context)){
						await this.plugin.context.addFolderToContext(context as TFolder)
					}
					this.plugin.loadAI(this.plugin.context.getContextAsText())
					this.plugin.ui.resetChat(filename)
				});
		});
	}

	getMenuTitleOfItem(filename?: string){
		return "Open " + APP_NAME + " chat " + (filename? "(context: \"" + filename + "\")" :"(context-free)")
	}
}
