import {Menu, Notice, Plugin, TFile, TFolder, Workspace, WorkspaceLeaf} from 'obsidian';
import {SettingTab} from "./src/classes/settings-tab";
import {ChatWindow} from "./src/classes/chat-window";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {PluginSettings} from "./src/types";
import {FOLDER_NAME, ICON_NAME, VIEW_TYPE} from "./src/constants";
import {OllamaWrapper} from "./src/classes/ollama-wrapper";
import {FileManager} from "./src/classes/file-manager";
import {firstToUpper} from "./src/utils";
import {Contextualizer} from "./src/classes/contextualizer";

export default class OllamaPlugin extends Plugin {
	ui: ChatWindow;
	ai: OllamaWrapper
	context: Contextualizer
	settings: PluginSettings;
	fileManager: FileManager;

	async onload() {
		await this.loadSettings()
		this.loadFileManager()
		this.loadContextualizer()
		this.loadAI()
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerChatWindow()
		this.registerItemsToContextMenuInFileNavigator()// Register menu item for a triple-dot file menu & right-click menu within the left sidebar
		this.registerItemsToContextMenuInNotes()// Register menu item for right-click "context" menu, within the file view
	}

	getModelUserFriendlyName(){
		//Capitalize the first letter of the name and return everything up to the ':' symbol
		const nameBeforeColon = this.settings.aiModel.slice(0, this.settings.aiModel.indexOf(':'))
		return firstToUpper(nameBeforeColon);
	}

	registerItemsToContextMenuInFileNavigator(){
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.addMenuItemGeneralChats(menu)
				if (this.fileManager.isFile(file)) { // Single File: Add the same way we do from a note
					this.addMenuItemForSingleFileContextChats(menu, file as TFile);
				} else if (this.fileManager.isFolder(file)) { // Folder: Add files individually to context
					this.addMenuItemForMultiFileContextChats(menu, file as TFolder);
				}
			})
		);
	}

	registerItemsToContextMenuInNotes(){
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, _, {file}) => {
				this.addMenuItemGeneralChats(menu)
				if(file) this.addMenuItemForSingleFileContextChats(menu, file)
			})
		);
	}

	registerChatWindow(): void {
		this.registerView(
			VIEW_TYPE,
			(leaf) => {
				this.ui = new ChatWindow(leaf, this)
				return this.ui
			}
		);
	}

	addMenuItemGeneralChats(menu: Menu){
		menu.addItem((item) => {
			item
				.setTitle("Chat with " + this.getModelUserFriendlyName() + " Context-Free")
				.setIcon(ICON_NAME)
				.onClick(async () => {
					await this.activateViewInWorkspace(this.app.workspace);
					//Remove existing context and chat history
					this.loadAI()
					this.ui.resetChat()
				});
		});
	}

	addMenuItemForSingleFileContextChats(menu: Menu, file: TFile){
		menu.addItem((item) => {
			const filename = this.fileManager.readFilenameWithoutExtension(file)
			item
				.setTitle("Chat with " + this.getModelUserFriendlyName() + " about \"" + filename + "\"")
				.setIcon(ICON_NAME)
				.onClick(async () => {
					await this.activateViewInWorkspace(this.app.workspace);
					//Remove existing context and chat history
					this.loadContextualizer()
					await this.context.addFileToContext(file)
					this.loadAI(this.context.getContextAsText())
					this.ui.resetChat(filename)
				});
		});
	}

	addMenuItemForMultiFileContextChats(menu: Menu, folder: TFolder){
		menu.addItem((item) => {
			const filename = this.fileManager.readFilenameWithoutExtension(folder)
			item
				.setTitle("Chat with " + this.getModelUserFriendlyName() + " about \"" + filename + "\"")
				.setIcon(ICON_NAME)
				.onClick(async () => {
					await this.activateViewInWorkspace(this.app.workspace);
					//Remove existing context and chat history
					this.loadContextualizer()
					await this.context.addFolderToContext(folder)
					this.loadAI(this.context.getContextAsText())
					this.ui.resetChat(filename)
				});
		});
	}

	async saveChat() {
		if(!this.fileManager.isFolderPath(FOLDER_NAME))
			await this.fileManager.createFolder(FOLDER_NAME);

		const filepath = FOLDER_NAME +'/'+ this.ui.chatStarted.getTime()+' Chat with '+ this.getModelUserFriendlyName()+'.md';
		const content: string[] = ["## Chat"]
		for(const message of this.ui.chatMessages.get())
			content.push("#### "+message.role + "@" +message.timestamp, "- "+message.content);

		await this.fileManager.updateFile(filepath, content.join("\n"))
		new Notice('Chat saved in: ' + filepath);
	}

	async activateViewInWorkspace(workspace: Workspace){
		let leaf: WorkspaceLeaf;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length === 0) { // A leaf with our view already exists, use it
			leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
			await leaf.setViewState({type: VIEW_TYPE, active: true});
		} else { // View isn't found in workspace, create in sidebar as new leaf
			leaf = leaves[0];
		}
		await workspace.revealLeaf(leaf);// Expand the sidebar to show leaf if it's collapsed
	}

	loadAI(initialContext?: string){
		this.ai = new OllamaWrapper(this, initialContext ?? '');
	}

	loadContextualizer(){
		this.context = new Contextualizer(this)
	}

	loadFileManager(){
		this.fileManager = new FileManager(this.app.vault);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {

	}
}
