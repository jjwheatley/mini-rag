import {App, PluginSettingTab, Setting} from "obsidian";
import OllamaPlugin from "../../main";
import {DEFAULT_SETTINGS} from "../defaults";

export class SettingTab extends PluginSettingTab {
	plugin: OllamaPlugin;

	constructor(app: App, plugin: OllamaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	addOllamaURL(container: HTMLElement) {
		new Setting(container)
			.setName('Ollama URL')
			.setDesc('The local URL of the model you want to chat with')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.ollamaURL)
				.setValue(this.plugin.settings.ollamaURL)
				.onChange(async (value) => {
					this.plugin.settings.ollamaURL = value;
					await this.plugin.saveSettings();
				}));
	}

	addModelSelector(container: HTMLElement) {
		new Setting(container)
			.setName('Model')
			.setDesc('The model you want to chat with')
			.addDropdown((dropdown) => {
				this.plugin.ai.getModelList().then(options => {
					for(let i =0; i< options.length; i++) {
						const opt = options[i]
						dropdown.addOption(opt, opt)
					}
					dropdown.setValue(this.plugin.settings.aiModel)
				})

				dropdown.onChange(async (value) => {
					this.plugin.settings.aiModel = value
					await this.plugin.saveSettings();
				});
			});
	}

	addHyperParameterTemperature(container: HTMLElement) {
		new Setting(container)
			.setName('Temperature')
			.setDesc('Controls the temperature hyper parameter of the model')
			.addSlider(slider => slider
				.setLimits(0.1, 1.0, 0.05)
				.setValue(this.plugin.settings.temperature)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				})
			)
	}

	addEnableContextFreeChats(container: HTMLElement) {
		new Setting(container)
			.setName('Enable context-free chats')
			.setDesc('Add the option for LLM chats without the context of a note or folder')
			.addToggle(slider => slider
				.setValue(this.plugin.settings.isContextFreeChatsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.isContextFreeChatsEnabled = value;
					await this.plugin.saveSettings();
				})
			)
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		this.addOllamaURL(containerEl);
		this.addModelSelector(containerEl);
		this.addHyperParameterTemperature(containerEl);
		this.addEnableContextFreeChats(containerEl);
	}
}
