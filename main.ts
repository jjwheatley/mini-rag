import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf  } from 'obsidian';

interface PluginSettings {
	aiModal: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	aiModal: '',
}

export const VIEW_TYPE = 'ollama-chat-window';

export class PanelView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "brain"
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'Example view';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl('h4', { text: 'Example view' });
		container.createEl('textarea', { placeholder: 'Type your question here', cls: "ollamaPluginQuestionBox" });
	}

	async onClose() {
		// Nothing to clean up.
	}
}

export default class OllamaPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE,
			(leaf) => new PanelView(leaf)
		);

		this.addRibbonIcon('brain', 'Ask Ollama', () => {
			this.activateView();
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status Bar Text');

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

class SettingTab extends PluginSettingTab {
	plugin: OllamaPlugin;

	constructor(app: App, plugin: OllamaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getModalOptions(): string[] {
		const result = ["mistral", "llama2"]; // ToDo: Load from Ollama
		result.sort((a, b) => a.localeCompare(b));
		return result;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Modal')
			.setDesc('The modal you want to chat with')
			.addDropdown((dropdown) => {
				const options = this.getModalOptions()
				for(let i =0; i<options.length; i++) {
					const opt = options[i]
					dropdown.addOption(opt, opt)
				}
				dropdown.setValue(this.plugin.settings.aiModal)

				dropdown.onChange(async (value) => {
					this.plugin.settings.aiModal = value
					await this.plugin.saveSettings();
						// this.plugin.settings.cycleDurationMinutes = +value;
				});
			});

	}
}
