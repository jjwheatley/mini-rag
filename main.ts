import { Plugin, WorkspaceLeaf } from 'obsidian';
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
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if(leaf)
				await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf)
			await workspace.revealLeaf(leaf);
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

