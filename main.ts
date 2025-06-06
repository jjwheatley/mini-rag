import {Menu, Notice, Plugin, TAbstractFile, Workspace, WorkspaceLeaf} from 'obsidian';
import {SettingTab} from "./src/classes/settings-tab";
import {ChatWindow} from "./src/classes/chat-window";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {PluginSettings} from "./src/types";
import {FOLDER_NAME, ICON_NAME, VIEW_TYPE} from "./src/constants";
import {OllamaWrapper} from "./src/classes/ollama-wrapper";

export default class OllamaPlugin extends Plugin {
	settings: PluginSettings;
	view: ChatWindow;
	ai: OllamaWrapper

	isFolderPath(path: string): boolean {
		return this.app.vault.getFolderByPath(path) != null;
	}

	async createFolder(path: string) {
		await this.app.vault.createFolder(path);
	}

	async deleteFileIfExists(path: string) {
		const file = this.app.vault.getFileByPath(path)
		if(file) {
			await this.app.vault.delete(file)
		}
	}


	async saveChat() {
 		if(!this.isFolderPath(FOLDER_NAME)){
			await this.createFolder(FOLDER_NAME);
		}

		const filename = FOLDER_NAME +'/'+ this.view.chatStarted.getTime()+' Chat with '+ this.getModelUserFriendlyName()+'.md';

		const content: string[] = ["## Chat"]
		for(const message of this.view.messages){
			content.push(message.role + "@" +message.timestamp);
			content.push("- "+message.content);
		}

		await this.deleteFileIfExists(filename);
		await this.app.vault.create(filename, content.join("\n"));

		new Notice('Chat saved in: ' + filename);
	}

	async onload() {
		await this.loadSettings()
		this.ai = this.spawnAI()

		this.registerView(
			VIEW_TYPE,
			(leaf) => {
				this.view = new ChatWindow(leaf, this)
				return this.view
			}
		);

		this.addRibbonIcon(ICON_NAME, 'Ask Ollama (without context)', () => {
			//Remove existing context and chat history
			this.ai = this.spawnAI()
			this.view.resetChat()
			this.activateViewInWorkspace(this.app.workspace);
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// Register menu item for a triple-dot file menu & right-click menu within the left sidebar
		// this.registerEvent(
		// 	this.app.workspace.on("file-menu", (menu, file) => {
		// 		this.registerMenuItem(menu, file)
		// 	})
		// );

		// Register menu item for right-click "context" menu, within the file view
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, _, {file}) => {
				if(file) this.registerMenuItem(menu, file)
			})
		);
	}

	onunload() {

	}

	spawnAI(initialContext?: string){
		return new OllamaWrapper(this, initialContext ?? '');
	}

	getModelUserFriendlyName(){
		//Capitalize the first letter of the name and return everything up to the ':' symbol
		return `${this.settings.aiModel.charAt(0).toUpperCase()}${this.settings.aiModel.slice(1, this.settings.aiModel.indexOf(':'))}`;
	}

	isMarkdownFilename(filename: string) {
		return filename.endsWith(".md");
	}

	getFilenameWithoutExtension(file: TAbstractFile){
		const isMarkdownFile = this.isMarkdownFilename(file.name)
		if(isMarkdownFile){
			return file.name.slice(0,-3)
		}else{
			return file.name;
		}
	}


	registerMenuItem(menu: Menu, file: TAbstractFile){
		menu.addItem((item) => {
			const filename = this.getFilenameWithoutExtension(file)
			item
				.setTitle("Chat with " + this.getModelUserFriendlyName() + " about \"" + filename + "\"")
				.setIcon(ICON_NAME)
				.onClick(async () => {
					const context = file ? await this.getFileText(file.path) : ""
					//Remove existing context and chat history
					this.ai = this.spawnAI(context)
					this.view.resetChat(filename)

					await this.activateViewInWorkspace(this.app.workspace);
				});
		});
	}

	async activateViewInWorkspace(workspace: Workspace){
		let leaf: WorkspaceLeaf;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length > 0) { // A leaf with our view already exists, use it
			leaf = leaves[0];
			await workspace.revealLeaf(leaf);// Expand the sidebar to show leaf if it's collapsed
		} else { // View isn't found in workspace, create in sidebar as new leaf
			const rightMostLeaf = workspace.getRightLeaf(false);
			if(rightMostLeaf) {
				leaf = rightMostLeaf
				await leaf.setViewState({type: VIEW_TYPE, active: true});
				await workspace.revealLeaf(leaf);// Expand the sidebar to show leaf if it's collapsed
			}
		}
	}

	async getFileText(contextFilePath: string){
		const file = this.app.vault.getFileByPath(contextFilePath)
		return !file ? "" : await this.app.vault.read(file);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}

