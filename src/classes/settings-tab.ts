import {App, DropdownComponent, PluginSettingTab, Setting} from "obsidian";
import MiniRagPlugin from "../../main";
import {DEFAULT_SETTINGS} from "../defaults";
import {CSS_CLASS_PREFIX} from "../constants";

export class SettingTab extends PluginSettingTab {
	plugin: MiniRagPlugin;
	private modelDropdown: DropdownComponent | null = null;
	private modelSetting: Setting | null = null;
	private modelStatusEl: HTMLElement | null = null;
	private isLoadingModels = false;
	private urlDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: MiniRagPlugin) {
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
					this.plugin.settings.ollamaURL = value.trim() || DEFAULT_SETTINGS.ollamaURL;
					text.setValue(this.plugin.settings.ollamaURL);
					await this.plugin.saveSettings();
					if (this.urlDebounceTimer !== null) clearTimeout(this.urlDebounceTimer);
					this.urlDebounceTimer = setTimeout(() => {
						this.urlDebounceTimer = null;
						void this.refreshModelList();
					}, 400);
				}));
	}

	addModelSelector(container: HTMLElement) {
		this.modelSetting = new Setting(container)
			.setName('Model')
			.setDesc('Loading models from Ollama…')
			.addExtraButton((button) => {
				button
					.setIcon('refresh-cw')
					.setTooltip('Reload model list')
					.onClick(() => this.refreshModelList());
			})
			.addDropdown((dropdown) => {
				this.modelDropdown = dropdown;
				dropdown.onChange(async (value) => {
					this.plugin.settings.aiModel = value;
					await this.plugin.saveSettings();
					this.updateModelValidationDesc();
				});
			});

		this.modelStatusEl = this.modelSetting.descEl.createDiv({
			cls: CSS_CLASS_PREFIX + "settings-status",
		});
	}

	private clearModelDropdown() {
		if (!this.modelDropdown) {
			return;
		}
		const select = this.modelDropdown.selectEl;
		while (select.options.length > 0) {
			select.remove(0);
		}
	}

	private setModelStatus(message: string, variant: "default" | "error" | "warning" = "default") {
		if (!this.modelStatusEl) {
			return;
		}
		this.modelStatusEl.setText(message);
		this.modelStatusEl.classList.remove('is-error', 'is-warning');
		if (variant === 'error') {
			this.modelStatusEl.classList.add('is-error');
		} else if (variant === 'warning') {
			this.modelStatusEl.classList.add('is-warning');
		}
	}

	private updateModelValidationDesc() {
		if (!this.modelSetting) {
			return;
		}
		const baseDesc = "The model you want to chat with";
		if (!this.plugin.settings.aiModel) {
			this.modelSetting.setDesc(
				baseDesc + ". Select a model — context menu items stay hidden until one is chosen."
			);
			this.setModelStatus(
				"No model selected. Install a model in Ollama, then pick it here.",
				"warning"
			);
		} else {
			this.modelSetting.setDesc(baseDesc);
			this.setModelStatus('');
		}
	}

	async refreshModelList(): Promise<void> {
		if (!this.modelDropdown || this.isLoadingModels) {
			return;
		}

		this.isLoadingModels = true;
		this.modelSetting?.setDesc("Loading models from Ollama…");
		this.setModelStatus('');

		try {
			const models = await this.plugin.ai.getModelList();
			this.clearModelDropdown();
			this.modelDropdown.addOption("", "— Select a model —");

			for (const model of models) {
				this.modelDropdown.addOption(model, model);
			}

			const currentModel = this.plugin.settings.aiModel;
			if (currentModel && !models.includes(currentModel)) {
				this.modelDropdown.addOption(currentModel, `${currentModel} (not in list)`);
			}

			if (currentModel) {
				this.modelDropdown.setValue(currentModel);
			} else {
				this.modelDropdown.setValue("");
			}

			if (models.length === 0) {
				this.modelSetting?.setDesc("No models found. Install a model in Ollama, then click Refresh.");
				this.setModelStatus(
					`No models returned from ${this.plugin.settings.ollamaURL}.`,
					"warning"
				);
			} else {
				this.updateModelValidationDesc();
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.modelSetting?.setDesc("Could not load models from Ollama.");
			this.setModelStatus(
				`Could not reach Ollama at ${this.plugin.settings.ollamaURL}. ${detail}`,
				"error"
			);
		} finally {
			this.isLoadingModels = false;
		}
	}

	addHyperParameterTemperature(container: HTMLElement) {
		new Setting(container)
			.setName('Temperature')
			.setDesc('Higher = more creative responses; lower = more focused and consistent')
			.addSlider(slider => slider
				.setLimits(0, 1.0, 0.05)
				.setValue(this.plugin.settings.temperature)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				})
			);
	}

	addEmbeddingModelSetting(container: HTMLElement) {
		new Setting(container)
			.setName('Embedding model')
			.setDesc('Ollama model used to generate embeddings for RAG context retrieval')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.embeddingModel)
				.setValue(this.plugin.settings.embeddingModel)
				.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value.trim() || DEFAULT_SETTINGS.embeddingModel;
					text.setValue(this.plugin.settings.embeddingModel);
					await this.plugin.saveSettings();
				}));
	}


	addRagTopKSetting(container: HTMLElement) {
		new Setting(container)
			.setName('Retrieved chunks (top-K)')
			.setDesc('Number of note excerpts to inject into each query')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.ragTopK)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.ragTopK = value;
					await this.plugin.saveSettings();
				}));
	}

	addEnableContextFreeChats(container: HTMLElement) {
		new Setting(container)
			.setName('Enable context-free chats')
			.setDesc('Add the option for LLM chats without the context of a note or folder')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.isContextFreeChatsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.isContextFreeChatsEnabled = value;
					await this.plugin.saveSettings();
				})
			);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		this.modelDropdown = null;
		this.modelSetting = null;
		this.modelStatusEl = null;
		this.addOllamaURL(containerEl);
		this.addModelSelector(containerEl);
		this.addHyperParameterTemperature(containerEl);
		this.addEmbeddingModelSetting(containerEl);
		this.addRagTopKSetting(containerEl);
		this.addEnableContextFreeChats(containerEl);
		void this.refreshModelList();
	}
}
