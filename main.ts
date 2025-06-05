import {Menu, Plugin, TAbstractFile} from 'obsidian';
import {SettingTab} from "./src/classes/settings-tab";
import {PanelView} from "./src/classes/panel-view";
import {DEFAULT_SETTINGS} from "./src/defaults";
import {PluginSettings} from "./src/types";
import {ICON_NAME, VIEW_TYPE} from "./src/constants";
import {OllamaWrapper} from "./src/classes/ollama-wrapper";
import {activateViewInWorkspace} from "./src/utils";

export default class OllamaPlugin extends Plugin {
	settings: PluginSettings;
	view: PanelView;
	ai: OllamaWrapper

	async onload() {
		await this.loadSettings()
		this.ai = this.spawnAI()

		this.registerView(
			VIEW_TYPE,
			(leaf) => {
				this.view = new PanelView(leaf, this)
				return this.view
			}
		);

		this.addRibbonIcon(ICON_NAME, 'Ask Ollama (without context)', () => {
			//Remove existing context and chat history
			this.ai = this.spawnAI()
			this.view.resetChat()
			activateViewInWorkspace(this.app.workspace);
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
			this.app.workspace.on("editor-menu", (menu, _, {file}) => {
				this.registerMenuItem(menu, file)// Register a view menu item
			})
		);
	}

	onunload() {

	}

	spawnAI(initialContext?: string){
		return new OllamaWrapper(this, initialContext ?? '');
	}

	registerMenuItem(menu: Menu, file: TAbstractFile | null){
		menu.addItem((item) => {
			const filename = file?.name.slice(0,-3)
			item
				.setTitle("Chat with " + this.settings.aiModel + " about \"" + filename + "\"")
				.setIcon(ICON_NAME)
				.onClick(async () => {
					const context = file ? await this.getFileText(file.path) : ""
					//Remove existing context and chat history
					this.ai = this.spawnAI(context)
					this.view.resetChat(filename)

					await activateViewInWorkspace(this.app.workspace);
				});
		});
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

