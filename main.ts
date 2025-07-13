import {Notice, Plugin, Workspace, WorkspaceLeaf} from 'obsidian';
import {SettingTab} from "./src/classes/settings-tab";
import {ChatWindow} from "./src/classes/chat-window";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {PluginSettings} from "./src/types";
import {FOLDER_NAME, VIEW_TYPE} from "./src/constants";
import {OllamaWrapper} from "./src/classes/ollama-wrapper";
import {FileManager} from "./src/classes/file-manager";
import {firstToUpper} from "./src/utils";
import {Contextualizer} from "./src/classes/contextualizer";
import {MenuManager} from "./src/classes/menu-manager";

export default class OllamaPlugin extends Plugin {
	ui: ChatWindow;
	ai: OllamaWrapper;
	menu: MenuManager;
	context: Contextualizer;
	settings: PluginSettings;
	fileManager: FileManager;

	async onload() {
		await this.loadSettings();
		this.loadFileManager();
		this.loadContextualizer();
		this.loadAI();
		this.addSettingTab(new SettingTab(this.app, this));
		this.loadMenu();
	}

	onunload() {

	}

	async getChatWindow() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];


		if (!leaf) { // A leaf with our view already exists, use it
			leaf = await this.activateViewInWorkspace(this.app.workspace);
		}

		return leaf.view as ChatWindow;
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

		return leaf;
	}

	getModelUserFriendlyName(){
		const nameBeforeColon = this.settings.aiModel.slice(0, this.settings.aiModel.indexOf(':'));
		return firstToUpper(nameBeforeColon);
	}

	loadAI(initialContext?: string){
		this.ai = new OllamaWrapper(this, initialContext ?? '');
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

	async saveChat() {
		if(!this.fileManager.isFolderPath(FOLDER_NAME)) {
			await this.fileManager.createFolder(FOLDER_NAME);
		}
		const chatWindow = await this.getChatWindow();

		const filepath = FOLDER_NAME +'/'+ chatWindow.chatStarted.getTime()+' Chat with '+ this.getModelUserFriendlyName()+'.md';
		const content: string[] = ["## Chat"];
		for(const message of chatWindow.chatMessages.get()) {
			content.push("#### " + message.role + "@" + message.timestamp, "- " + message.content);
		}

		await this.fileManager.updateFile(filepath, content.join("\n"));
		new Notice('Chat saved in: ' + filepath);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
