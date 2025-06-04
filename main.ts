import {Menu, Notice, Plugin, TAbstractFile, WorkspaceLeaf} from 'obsidian';
import {PanelView} from "./src/classes/panel-view";
import {VIEW_TYPE} from "./src/constants";
import {PluginSettings} from "./src/types";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {SettingTab} from "./src/classes/settings-tab";


export default class OllamaPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE,
			(leaf) => new PanelView(leaf, this)
		);

		this.addRibbonIcon('brain', 'Ask Ollama', () => {
			this.activateView();
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));



		// Register menu items to allow passing notes as context
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.registerMenuItem(menu, file)// Register a file menu item
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if(view?.file)
					this.registerMenuItem(menu, view.file)// Register a view menu item
			})
		);
	}

	registerMenuItem(menu: Menu, file: TAbstractFile){
		menu.addItem((item) => {
			item
				.setTitle("Chat with " + this.settings.aiModal + " about \"" + file?.name.slice(0,-3)+ "\"")
				.setIcon("brain")
				.onClick(async () => {
					await this.activateView(file?.path);
				});
		});
	}

	async activateView(contextFilePath?: string) {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length > 0) { // A leaf with our view already exists, use it
			leaf = leaves[0];
			await workspace.revealLeaf(leaf);// "Reveal" leaf if sidebar is collapsed
		} else { // View isn't found in workspace, create in sidebar as new leaf
			const rightMostLeaf = workspace.getRightLeaf(false);
			if(rightMostLeaf) {
				leaf = rightMostLeaf
				await leaf.setViewState({type: VIEW_TYPE, active: true});
				await workspace.revealLeaf(leaf);// "Reveal" leaf if sidebar is collapsed
			}
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

