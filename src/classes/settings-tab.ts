import {App, PluginSettingTab, Setting} from "obsidian";
import OllamaPlugin from "../../main";
import {DEFAULT_SETTINGS} from "../defaults";

export class SettingTab extends PluginSettingTab {
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
				});
			});


		new Setting(containerEl)
			.setName('Ollama URL')
			.setDesc('The local URL of the modal you want to chat with')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.ollamaURL)
				.setValue(this.plugin.settings.ollamaURL)
				.onChange(async (value) => {
					this.plugin.settings.ollamaURL = value;
					await this.plugin.saveSettings();
				}));


	}
}
