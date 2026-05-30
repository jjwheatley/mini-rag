import {App, DropdownComponent, PluginSettingTab, Setting, setIcon} from "obsidian";
import MiniRagPlugin from "../../main";
import {DEFAULT_SETTINGS} from "../defaults";
import {CSS_CLASS_PREFIX} from "../constants";

const modelBase = (name: string) => name.split(':')[0];

export class SettingTab extends PluginSettingTab {
	plugin: MiniRagPlugin;
	private modelDropdown: DropdownComponent | null = null;
	private modelSetting: Setting | null = null;
	private modelStatusEl: HTMLElement | null = null;
	private isLoadingModels = false;
	private urlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private embeddingDropdown: DropdownComponent | null = null;
	private embeddingDropdownSetting: Setting | null = null;
	private embeddingDropdownContainerEl: HTMLElement | null = null;
	private embeddingStatusEl: HTMLElement | null = null;
	private installedModels: string[] = [];
	private static readonly CURATED_EMBEDDING_MODELS = [
		'all-minilm',             // fast & lightweight, good for lower-end hardware (~46 MB)
		'bge-m3',                 // multilingual, versatile (~1.2 GB)
		'mxbai-embed-large',      // high accuracy, MTEB state-of-the-art for its size (~670 MB)
		'nomic-embed-text',       // great all-rounder, most popular (~274 MB)
		'snowflake-arctic-embed', // strong retrieval performance (~670 MB)
	];

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
			this.installedModels = models;
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

			this.updateEmbeddingDropdown(models);
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
				.setLimits(0.1, 1.0, 0.05)
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
			.setName('Use a dedicated embedding model')
			.setDesc('Select a separate Ollama model to generate embeddings. When off, the chat model is used.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dedicatedEmbeddingEnabled)
				.onChange(async (value) => {
					this.plugin.settings.dedicatedEmbeddingEnabled = value;
					if (value && !this.plugin.settings.embeddingModel) {
						const defaultModel = this.installedModels.find(m =>
							SettingTab.CURATED_EMBEDDING_MODELS.some(c => modelBase(m) === c)
						) ?? SettingTab.CURATED_EMBEDDING_MODELS[0];
						this.plugin.settings.embeddingModel = defaultModel;
						this.updateEmbeddingDropdown(this.installedModels);
					}
					await this.plugin.saveSettings();
					if (this.embeddingDropdownContainerEl) {
						this.embeddingDropdownContainerEl.style.display = value ? '' : 'none';
					}
				}));

		this.embeddingDropdownContainerEl = container.createDiv();
		this.embeddingDropdownContainerEl.style.display = this.plugin.settings.dedicatedEmbeddingEnabled ? '' : 'none';

		this.embeddingDropdownSetting = new Setting(this.embeddingDropdownContainerEl)
			.setName('Embedding Model')
			.addExtraButton(btn => btn
				.setIcon('refresh-cw')
				.setTooltip('Check install status')
				.onClick(() => this.refreshEmbeddingStatus())
			)
			.addDropdown(dropdown => {
				this.embeddingDropdown = dropdown;
				dropdown.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
					this.updateEmbeddingPullHint();
				});
			});

		this.embeddingStatusEl = this.embeddingDropdownSetting.descEl.createDiv({
			cls: CSS_CLASS_PREFIX + 'settings-status',
		});
	}

	private async refreshEmbeddingStatus() {
		try {
			const models = await this.plugin.ai.getModelList();
			this.installedModels = models;
			this.updateEmbeddingDropdown(models);
		} catch { /* Ollama unreachable — leave labels as-is */ }
	}

	private updateEmbeddingDropdown(installedModels: string[]) {
		if (!this.embeddingDropdown || !this.embeddingDropdownSetting) return;

		const isInstalled = (model: string) =>
			installedModels.some(m => modelBase(m) === modelBase(model));

		const select = this.embeddingDropdown.selectEl;
		while (select.childNodes.length > 0) select.removeChild(select.childNodes[0]);

		const addGroup = (label: string, models: string[]) => {
			if (models.length === 0) return;
			const group = select.createEl('optgroup', {attr: {label}});
			for (const model of models) {
				group.createEl('option', {text: model, attr: {value: model}});
			}
		};

		addGroup('Installed', SettingTab.CURATED_EMBEDDING_MODELS.filter(isInstalled));
		addGroup('Not installed', SettingTab.CURATED_EMBEDDING_MODELS.filter(m => !isInstalled(m)));

		// Preserve a previously saved model that isn't in the curated list.
		const current = this.plugin.settings.embeddingModel;
		if (current && !SettingTab.CURATED_EMBEDDING_MODELS.includes(current)) {
			select.createEl('option', {text: `${current} (not in list)`, attr: {value: current}});
		}

		this.embeddingDropdown.setValue(current || SettingTab.CURATED_EMBEDDING_MODELS[0]);
		this.updateEmbeddingPullHint();
	}

	private updateEmbeddingPullHint() {
		if (!this.embeddingStatusEl) return;
		const model = this.plugin.settings.embeddingModel;
		const isInstalled = !!model && this.installedModels.some(
			m => modelBase(m) === modelBase(model)
		);

		this.embeddingStatusEl.empty();
		this.embeddingStatusEl.classList.toggle('is-success', isInstalled);
		this.embeddingStatusEl.classList.toggle('is-warning', !isInstalled);

		if (isInstalled) {
			this.embeddingStatusEl.appendText('Installed');
		} else {
			const textCol = this.embeddingStatusEl.createDiv();
			textCol.createDiv({text: 'This model is not installed.'});
			const installLine = textCol.createDiv();
			installLine.appendText('Install with: ');
			installLine.createEl('code', {text: `ollama pull ${model}`});

			const copyBtn = this.embeddingStatusEl.createEl('button', {
				cls: CSS_CLASS_PREFIX + 'inline-copy-btn',
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				navigator.clipboard.writeText(`ollama pull ${model}`);
			});
		}
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
		this.embeddingDropdown = null;
		this.embeddingDropdownSetting = null;
		this.embeddingDropdownContainerEl = null;
		this.embeddingStatusEl = null;
		this.addOllamaURL(containerEl);
		this.addModelSelector(containerEl);
		this.addHyperParameterTemperature(containerEl);
		this.addRagTopKSetting(containerEl);
		this.addEnableContextFreeChats(containerEl);
		this.addEmbeddingModelSetting(containerEl);
		void this.refreshModelList();
	}
}
