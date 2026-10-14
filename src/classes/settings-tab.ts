import {App, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon} from "obsidian";
import MiniRagPlugin from "../../main";
import {DEFAULT_PROVIDER_CONFIGS} from "../defaults";
import {activeProviderConfig, activeProviderId, trimSlash} from "../settings";
import {ProviderUnreachableError} from "../providers/errors";
import {CSS_CLASS_PREFIX} from "../constants";
import {listProviders} from "../providers/factory";
import {ProviderId} from "../types";

/** Splits a command into its words, each flag joined to the value that follows it. */
function commandGroups(command: string): string[] {
	const words = command.split(' ');
	const groups: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const next = words[i + 1];
		if (words[i].startsWith('-') && next !== undefined && !next.startsWith('-')) {
			groups.push(`${words[i]} ${next}`);
			i++;
		} else {
			groups.push(words[i]);
		}
	}
	return groups;
}

/**
 * The settings tab. Everything provider-specific — labels, which fields appear, how an embedding
 * model is chosen, what to tell the user when one is missing — is read from the active provider's
 * capabilities and hints, so a new backend needs no changes here.
 */
export class SettingTab extends PluginSettingTab {
	plugin: MiniRagPlugin;
	private modelDropdown: DropdownComponent | null = null;
	private modelSetting: Setting | null = null;
	private modelStatusEl: HTMLElement | null = null;
	/** Beside the "Connect to …" step: whether the server answered the model-list check. */
	private connectionStatusEl: HTMLElement | null = null;
	/** How to load another chat model, for providers that say. */
	private chatHintEl: HTMLElement | null = null;
	private isLoadingModels = false;
	/**
	 * Bumped by every render. A model list requested before a re-render — say, from the provider
	 * the user just switched away from — can be recognised when it arrives, and dropped.
	 */
	private renderSeq = 0;
	private urlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private embeddingUrlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private embeddingDropdown: DropdownComponent | null = null;
	private embeddingDropdownContainerEl: HTMLElement | null = null;
	private embeddingStatusEl: HTMLElement | null = null;
	/** The Embedding Model row, across whose bottom a missing model's details go. */
	private embeddingSettingEl: HTMLElement | null = null;
	/** Details for a model that is not available; absent while it is. */
	private embeddingHintEl: HTMLElement | null = null;
	/** Models the chat server reports, for matching a curated embedding list against. */
	private installedModels: string[] = [];
	/** Embedding models the server itself reports, for providers that can list them. */
	private listedEmbeddingModels: string[] = [];
	/**
	 * Why the last embedding-model listing failed — a status line, and any detail for under it —
	 * or null when it worked.
	 */
	private embeddingListFailure: {status: string; detail: string | null} | null = null;
	/** Whether the embedding models are being listed; the picker waits, and says so, meanwhile. */
	private embeddingLoading = false;

	constructor(app: App, plugin: MiniRagPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** The active backend's settings. Read fresh each time so a provider switch is picked up. */
	private get config() {
		return activeProviderConfig(this.plugin.settings);
	}

	/** Defaults for the active backend, used for placeholder text. */
	private get configDefaults() {
		return DEFAULT_PROVIDER_CONFIGS[activeProviderId(this.plugin.settings)];
	}

	private get providerName(): string {
		return this.plugin.ai.capabilities.displayName;
	}

	// --- Provider and server -----------------------------------------------------------------

	private addHeading(container: HTMLElement, name: string): Setting {
		return new Setting(container).setName(name).setHeading();
	}

	/**
	 * Whether step 2 is done, at a glance: taken from the model-list check the tab makes anyway, so
	 * it costs no request of its own. Reachable is what counts; an empty list warns on its own row.
	 */
	private setConnectionStatus(state: 'checking' | 'connected' | 'disconnected') {
		const el = this.connectionStatusEl;
		if (!el) return;
		el.setText({checking: 'Checking…', connected: '✓ Connected', disconnected: 'Not connected'}[state]);
		el.classList.toggle('is-connected', state === 'connected');
		el.classList.toggle('is-disconnected', state === 'disconnected');
	}

	addProviderSelector(container: HTMLElement) {
		new Setting(container)
			.setName('Provider')
			.setDesc('Which local server Mini-RAG talks to. URLs and model choices are remembered for each provider.')
			.addDropdown(dropdown => {
				for (const {id, displayName} of listProviders()) {
					dropdown.addOption(id, displayName);
				}
				dropdown.setValue(activeProviderId(this.plugin.settings));
				dropdown.onChange(async (value) => {
					if (value === this.plugin.settings.provider) return;
					this.plugin.settings.provider = value as ProviderId;
					await this.plugin.saveSettings();
					// The old provider may be mid-answer. Its replacement also starts a fresh
					// conversation, since the new backend knows nothing of the old one's history.
					this.plugin.ai.abort();
					this.plugin.loadAI();
					this.display();
					this.plugin.notifyChatModelChanged();
				});
			});
	}

	addServerUrl(container: HTMLElement) {
		new Setting(container)
			.setName(`${this.providerName} URL`)
			.setDesc('The local address of the server Mini-RAG chats with')
			.addText(text => text
				.setPlaceholder(this.configDefaults.url)
				.setValue(this.config.url)
				.onChange(async (value) => {
					this.config.url = value.trim() || this.configDefaults.url;
					text.setValue(this.config.url);
					await this.plugin.saveSettings();
					// The command to start a model names this URL's port.
					this.updateChatModelHint();
					if (this.urlDebounceTimer !== null) clearTimeout(this.urlDebounceTimer);
					this.urlDebounceTimer = setTimeout(() => {
						this.urlDebounceTimer = null;
						void this.refreshModelList();
					}, 400);
				}));
	}

	/**
	 * Only for providers that serve one model per process, where the dedicated embedding model needs
	 * a second server. Shown with that model, since it is where that model runs.
	 */
	addEmbeddingServerUrl(container: HTMLElement) {
		if (!this.plugin.ai.capabilities.separateEmbeddingEndpoint) return;

		new Setting(container)
			.setName('Embedding server URL')
			.setDesc('The second server, running your embedding model. Its model is listed below.')
			.addText(text => text
				.setPlaceholder(this.configDefaults.embeddingUrl)
				.setValue(this.config.embeddingUrl)
				.onChange(async (value) => {
					// Like the main URL, a cleared field falls back to the default: saving a blank
					// would leave the placeholder looking like a value that is not there.
					this.config.embeddingUrl = value.trim() || this.configDefaults.embeddingUrl;
					text.setValue(this.config.embeddingUrl);
					await this.plugin.saveSettings();
					// The embedding picker lists what this server runs, so ask the new address.
					if (this.embeddingUrlDebounceTimer !== null) clearTimeout(this.embeddingUrlDebounceTimer);
					this.embeddingUrlDebounceTimer = setTimeout(() => {
						this.embeddingUrlDebounceTimer = null;
						void this.refreshEmbeddingOptions(this.installedModels);
					}, 400);
				}));
	}

	// --- Chat model --------------------------------------------------------------------------

	addModelSelector(container: HTMLElement) {
		this.modelSetting = new Setting(container)
			.setName('Chat Model')
			.setDesc(`Loading models from ${this.providerName}…`)
			.addExtraButton((button) => {
				button
					.setIcon('refresh-cw')
					.setTooltip('Reload model list')
					.onClick(() => this.refreshModelList());
			})
			.addDropdown((dropdown) => {
				this.modelDropdown = dropdown;
				dropdown.onChange(async (value) => {
					this.config.chatModel = value;
					await this.plugin.saveSettings();
					this.plugin.notifyChatModelChanged();
					this.updateModelValidationDesc();
				});
			});

		this.modelStatusEl = this.modelSetting.descEl.createDiv({
			cls: CSS_CLASS_PREFIX + "settings-status",
		});
		this.updateChatModelHint();
	}

	/** Across the bottom of the Chat Model row: how to load another model, where the provider says. */
	private updateChatModelHint() {
		this.chatHintEl?.remove();
		this.chatHintEl = null;
		const hint = this.plugin.ai.chatModelInstallHint?.();
		if (!hint || !this.modelSetting) return;
		this.chatHintEl = this.renderHint(this.modelSetting.settingEl, [hint.summary], hint.command);
	}

	/**
	 * Sets the Chat Model description. Obsidian's setDesc replaces everything in it, the status line
	 * included, so that is put back after.
	 */
	private setModelDesc(desc: string) {
		if (!this.modelSetting) return;
		this.modelSetting.setDesc(desc);
		if (this.modelStatusEl) this.modelSetting.descEl.appendChild(this.modelStatusEl);
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
		if (!this.config.chatModel) {
			this.setModelDesc(
				baseDesc + ". Select a model — context menu items stay hidden until one is chosen."
			);
			this.setModelStatus(
				`No model selected. Install a model in ${this.providerName}, then pick it here.`,
				"warning"
			);
		} else {
			this.setModelDesc(baseDesc);
			this.setModelStatus('');
		}
	}

	async refreshModelList(): Promise<void> {
		if (!this.modelDropdown || this.isLoadingModels) {
			return;
		}

		this.isLoadingModels = true;
		const seq = this.renderSeq;
		this.setModelDesc(`Loading models from ${this.providerName}…`);
		this.setModelStatus('');
		this.setConnectionStatus('checking');
		// An empty picker looks broken; say what is going on, and hold it until the list arrives.
		this.clearModelDropdown();
		this.modelDropdown.addOption('', 'Loading…');
		this.modelDropdown.selectEl.disabled = true;

		try {
			const models = await this.plugin.ai.getModelList();
			// Re-rendered while waiting: this list belongs to a view that no longer exists.
			if (seq !== this.renderSeq) return;
			this.setConnectionStatus('connected');
			// Where the server decides the model (llama.cpp), the one it runs is the one in use:
			// follow it, rather than keep a choice that would only be a label.
			if (this.plugin.ai.capabilities.modelFixedByServer && models.length === 1
				&& this.config.chatModel !== models[0]) {
				this.config.chatModel = models[0];
				await this.plugin.saveSettings();
			}
			this.modelDropdown.selectEl.disabled = false;
			this.clearModelDropdown();
			this.modelDropdown.addOption("", "— Select a model —");

			for (const model of models) {
				this.addModelOption(this.modelDropdown.selectEl, model);
			}

			const currentModel = this.config.chatModel;
			if (currentModel && !models.includes(currentModel)) {
				this.addModelOption(this.modelDropdown.selectEl, currentModel, ' (not in list)');
			}

			if (currentModel) {
				this.modelDropdown.setValue(currentModel);
			} else {
				this.modelDropdown.setValue("");
			}

			if (models.length === 0) {
				this.setModelDesc(`No models found. Install a model in ${this.providerName}, then click Refresh.`);
				this.setModelStatus(
					`No models returned from ${this.config.url}.`,
					"warning"
				);
			} else {
				this.updateModelValidationDesc();
			}

			await this.refreshEmbeddingOptions(models);
		} catch (error) {
			if (seq !== this.renderSeq) return;
			this.setConnectionStatus('disconnected');
			// No list to offer, but still show what is configured, or say there is nothing.
			this.modelDropdown.selectEl.disabled = false;
			this.clearModelDropdown();
			const currentModel = this.config.chatModel;
			if (currentModel) {
				this.addModelOption(this.modelDropdown.selectEl, currentModel);
				this.modelDropdown.setValue(currentModel);
			} else {
				this.modelDropdown.addOption('', 'No models');
			}

			const detail = error instanceof Error ? error.message : String(error);
			this.setModelDesc(`Could not load models from ${this.providerName}.`);
			// Nothing listening needs saying once; the transport's own words only repeat it.
			this.setModelStatus(
				error instanceof ProviderUnreachableError
					? `Nothing is running at ${trimSlash(this.config.url)}.`
					: `Could not reach ${this.providerName} at ${this.config.url}. ${detail}`,
				"error"
			);
			// A separate embedding server may well be up, so still ask it. Where one server hosts
			// both, there is nothing more to learn: just stop checking.
			if (this.plugin.ai.capabilities.separateEmbeddingEndpoint) {
				await this.refreshEmbeddingOptions(this.installedModels);
			} else {
				this.setEmbeddingLoading(false);
			}
		} finally {
			// A stale refresh must not clear the flag that now belongs to the current render's.
			if (seq === this.renderSeq) this.isLoadingModels = false;
		}
	}

	// --- Generation --------------------------------------------------------------------------

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

	// --- Embedding model ---------------------------------------------------------------------

	addEmbeddingModelSetting(container: HTMLElement) {
		new Setting(container)
			.setName('Use a dedicated embedding model')
			.setDesc(`Select a separate ${this.providerName} model to generate embeddings. When off, the chat model is used.`)
			.addToggle(toggle => toggle
				.setValue(this.config.dedicatedEmbeddingEnabled)
				.onChange(async (value) => {
					this.config.dedicatedEmbeddingEnabled = value;
					if (value && !this.config.embeddingModel) {
						this.config.embeddingModel = this.suggestedEmbeddingModel();
						this.updateEmbeddingPicker();
					}
					await this.plugin.saveSettings();
					if (this.embeddingDropdownContainerEl) {
						this.embeddingDropdownContainerEl.style.display = value ? '' : 'none';
					}
				}));

		this.embeddingDropdownContainerEl = container.createDiv();
		this.embeddingDropdownContainerEl.style.display = this.config.dedicatedEmbeddingEnabled ? '' : 'none';
		this.addEmbeddingServerUrl(this.embeddingDropdownContainerEl);

		const setting = new Setting(this.embeddingDropdownContainerEl)
			.setName('Embedding Model')
			.addExtraButton(btn => btn
				.setIcon('refresh-cw')
				.setTooltip('Check again')
				.onClick(() => this.refreshEmbeddingStatus())
			)
			.addDropdown(dropdown => {
				this.embeddingDropdown = dropdown;
				dropdown.onChange(async (value) => {
					this.config.embeddingModel = value;
					await this.plugin.saveSettings();
					// Check the choice against the server as it is now, not as it was when the list
					// was fetched: llama-server may have stopped, or Ollama pulled the model since.
					await this.refreshEmbeddingStatus();
				});
			});

		this.embeddingSettingEl = setting.settingEl;
		// Lets the hint wrap onto a full-width line of its own, inside the row.
		setting.settingEl.classList.add(CSS_CLASS_PREFIX + 'setting-with-hint');
		this.embeddingStatusEl = setting.descEl.createDiv({
			cls: CSS_CLASS_PREFIX + 'settings-status',
		});
		// The first listing is already on its way; show that rather than a blank picker.
		this.updateEmbeddingPicker();
	}

	/**
	 * What to pre-select when the dedicated model is switched on with nothing chosen: something the
	 * user already has, so the very next index build works without a download.
	 */
	private suggestedEmbeddingModel(): string {
		// A suggestion that is already running, then anything the embedding server runs, then the
		// first suggestion — which the panel then explains how to get.
		const available = this.availableEmbeddingModels;
		const installed = available.find(model => this.isCurated(model));
		const running = this.providerListsEmbeddingModels ? available[0] : undefined;
		return installed ?? running ?? this.plugin.ai.curatedEmbeddingModels()[0] ?? '';
	}

	/** Where the embedding models are listed from: the second server, where there is one. */
	private get embeddingServerUrl(): string {
		const config = this.config;
		return trimSlash(this.plugin.ai.capabilities.separateEmbeddingEndpoint ? config.embeddingUrl : config.url);
	}

	/** Whether the server can name its embedding models, rather than only its chat models. */
	private get providerListsEmbeddingModels(): boolean {
		return typeof this.plugin.ai.listEmbeddingModels === 'function';
	}

	/**
	 * What a curated suggestion is checked against: the embedding server's models where it can
	 * name them (llama.cpp's second server), otherwise everything installed (Ollama).
	 */
	private get availableEmbeddingModels(): string[] {
		return this.providerListsEmbeddingModels ? this.listedEmbeddingModels : this.installedModels;
	}

	private isCurated(model: string): boolean {
		return this.plugin.ai.curatedEmbeddingModels().some(candidate => this.plugin.ai.isSameModel(model, candidate));
	}

	/** Refreshes what the embedding picker offers, after the chat model list has loaded. */
	private async refreshEmbeddingOptions(chatModels: string[]) {
		this.installedModels = chatModels;
		if (this.providerListsEmbeddingModels) {
			this.setEmbeddingLoading(true);
			try {
				this.listedEmbeddingModels = await this.plugin.ai.listEmbeddingModels?.() ?? [];
				this.embeddingListFailure = null;
			} catch (error) {
				// Unreachable — offer nothing rather than a stale list, and say why: plainly, since
				// the transport's own words are along the lines of "net::ERR_CONNECTION_REFUSED".
				this.listedEmbeddingModels = [];
				this.embeddingListFailure = error instanceof ProviderUnreachableError
					? {status: `Nothing is running at ${this.embeddingServerUrl}`, detail: null}
					: {status: 'Could not list the embedding models', detail: this.plugin.ai.formatError(error)};
			}
		}

		this.embeddingLoading = false;

		// With none saved, adopt a model that is actually there, so what the picker shows is what the
		// index uses. A suggestion nothing runs is not saved: it would stick once one was started.
		if (this.config.dedicatedEmbeddingEnabled && !this.config.embeddingModel) {
			const suggested = this.suggestedEmbeddingModel();
			if (this.isEmbeddingModelAvailable(suggested)) {
				this.config.embeddingModel = suggested;
				await this.plugin.saveSettings();
			}
		}
		this.updateEmbeddingPicker();
	}

	/** Checks the embedding models again: from the refresh button, and whenever one is chosen. */
	private async refreshEmbeddingStatus() {
		this.setEmbeddingLoading(true);
		// A separate embedding server answers for itself, whether or not the chat server is up.
		if (this.plugin.ai.capabilities.separateEmbeddingEndpoint) {
			await this.refreshEmbeddingOptions(this.installedModels);
			return;
		}
		try {
			await this.refreshEmbeddingOptions(await this.plugin.ai.getModelList());
		} catch {
			// Server unreachable — leave the labels as they were.
			this.setEmbeddingLoading(false);
		}
	}

	private setEmbeddingLoading(loading: boolean) {
		this.embeddingLoading = loading;
		this.updateEmbeddingPicker();
	}

	private updateEmbeddingPicker() {
		if (this.embeddingDropdown) {
			const select = this.embeddingDropdown.selectEl;
			// While listing, hold the picker: keep what it had (or say it is loading) and disable it,
			// so a choice cannot be made from a list about to change.
			select.disabled = this.embeddingLoading;
			if (this.embeddingLoading) {
				if (select.options.length === 0) select.createEl('option', {text: 'Loading…', attr: {value: ''}});
				this.updateEmbeddingHint();
				return;
			}
			while (select.childNodes.length > 0) select.removeChild(select.childNodes[0]);

			// Nothing saved: say so, rather than showing a model the index would not use.
			const current = this.config.embeddingModel;
			if (!current) select.createEl('option', {text: '— Select a model —', attr: {value: ''}});

			const offered = this.curatedOffering();

			// A curated list is a suggestion, so split it by what is actually there.
			const addGroup = (label: string, models: string[]) => {
				if (models.length === 0) return;
				const group = select.createEl('optgroup', {attr: {label}});
				for (const model of models) {
					this.addModelOption(group, model);
				}
			};
			const {available, unavailable} = this.availabilityLabels;
			addGroup(available, offered.filter(model => this.isInstalled(model)));
			addGroup(unavailable, offered.filter(model => !this.isInstalled(model)));

			// Preserve a previously saved model that is no longer offered.
			if (current && !offered.includes(current)) {
				this.addModelOption(select, current, ' (not in list)');
			}

			this.embeddingDropdown.setValue(current);
		}
		this.updateEmbeddingHint();
	}

	/**
	 * The curated suggestions, plus anything the embedding server runs that is not among them:
	 * whatever it was started with is a valid choice, listed or not.
	 */
	private curatedOffering(): string[] {
		const curated = this.plugin.ai.curatedEmbeddingModels();
		if (!this.providerListsEmbeddingModels) return curated;
		return [...curated, ...this.listedEmbeddingModels.filter(model => !this.isCurated(model))];
	}

	/**
	 * An option labelled with the model's name, keeping its id as the value and tooltip. Hugging
	 * Face ids and file paths are long; Ollama's are kept whole, since "llama3:8b" and
	 * "llama3:70b" differ only in the tag.
	 */
	private addModelOption(parent: HTMLElement, model: string, suffix = '') {
		const ai = this.plugin.ai;
		const label = ai.capabilities.modelIdsHaveTags ? model : ai.displayModelName(model) || model;
		parent.createEl('option', {text: label + suffix, attr: {value: model, title: model}});
	}

	/**
	 * What a model that is there is called. Where the server decides the model (llama.cpp), it is
	 * one the server was started with, not one installed: so "Running".
	 */
	private get availabilityLabels(): {available: string; unavailable: string} {
		return this.plugin.ai.capabilities.modelFixedByServer
			? {available: 'Running', unavailable: 'Not running'}
			: {available: 'Installed', unavailable: 'Not installed'};
	}

	private isInstalled(model: string): boolean {
		return this.availableEmbeddingModels.some(installed => this.plugin.ai.isSameModel(installed, model));
	}

	private isEmbeddingModelAvailable(model: string): boolean {
		return model !== '' && this.isInstalled(model);
	}

	/** The status for a model that is not available: the reason, so it need not be repeated below. */
	private unavailableReason(): string {
		if (this.embeddingListFailure) return this.embeddingListFailure.status;
		if (this.plugin.ai.capabilities.separateEmbeddingEndpoint && !this.config.embeddingUrl) {
			// With no address there is nothing to ask, so an empty picker needs this explanation.
			return 'No embedding server URL set';
		}
		const running = this.runningInsteadOfChoice();
		if (running) return `Not running — using ${this.plugin.ai.displayModelName(running)}`;
		return 'Not available';
	}

	/**
	 * Where the server decides the model (llama.cpp), embeddings come from whatever the embedding
	 * server runs, chosen or not: the model it runs instead of the one chosen, if any.
	 */
	private runningInsteadOfChoice(): string | null {
		if (!this.plugin.ai.capabilities.modelFixedByServer || this.embeddingListFailure) return null;
		return this.listedEmbeddingModels[0] ?? null;
	}

	private updateEmbeddingHint() {
		if (!this.embeddingStatusEl) return;
		const model = this.config.embeddingModel;
		const available = this.isEmbeddingModelAvailable(model);

		// A short status that says why, and, when the model is missing, what to run across the
		// bottom of the row: full width, but inside it, since a panel between rows made the page jump.
		this.embeddingHintEl?.remove();
		this.embeddingHintEl = null;

		const loading = this.embeddingLoading;
		this.embeddingStatusEl.setText(loading ? 'Checking…' : available ? this.availabilityLabels.available : this.unavailableReason());
		// Prefixed: Obsidian draws its own progress bar over any element with a bare "is-loading".
		this.embeddingStatusEl.classList.toggle(CSS_CLASS_PREFIX + 'checking', loading);
		this.embeddingStatusEl.classList.toggle('is-success', !loading && available);
		this.embeddingStatusEl.classList.toggle('is-warning', !loading && !available);
		if (loading || available || !this.embeddingSettingEl) return;

		// The words come from the active provider: `ollama pull`, or a second llama-server.
		const hint = this.plugin.ai.embeddingInstallHint(model);
		const detail = this.embeddingListFailure?.detail;
		const running = this.runningInsteadOfChoice();
		const name = (id: string) => this.plugin.ai.displayModelName(id);
		const note = hint.commandNote ? ` (${hint.commandNote})` : '';
		const lines = running
			? [`The embedding server is running ${name(running)}, so Mini-RAG uses that. To use ${name(model)} instead, restart it with:`]
			: [
				...(detail ? [detail] : []),
				hint.summary,
				...(hint.command ? [`Run this command${note}:`] : []),
			];
		this.embeddingHintEl = this.renderHint(this.embeddingSettingEl, lines, hint.command);
	}

	/**
	 * A hint across the bottom of a setting row: a few lines, then a command on its own line with a
	 * copy button. The row wraps to make room for it.
	 */
	private renderHint(settingEl: HTMLElement, lines: string[], command: string | null): HTMLElement {
		settingEl.classList.add(CSS_CLASS_PREFIX + 'setting-with-hint');
		const hintEl = settingEl.createDiv({cls: CSS_CLASS_PREFIX + 'settings-hint'});
		for (const text of lines) hintEl.createDiv({text, cls: CSS_CLASS_PREFIX + 'settings-hint-line'});

		if (command) {
			const commandRow = hintEl.createDiv({cls: CSS_CLASS_PREFIX + 'settings-hint-command'});
			// Each flag kept with its value, so a long command wraps between flags, never inside one.
			const code = commandRow.createEl('code');
			commandGroups(command).forEach((group, i) => {
				if (i > 0) code.appendText(' ');
				code.createSpan({text: group});
			});
			const copyBtn = commandRow.createEl('button', {
				cls: CSS_CLASS_PREFIX + 'inline-copy-btn',
				attr: {'aria-label': 'Copy command'},
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				// Copying changes nothing visible, so say whether it worked.
				navigator.clipboard.writeText(command).then(
					() => new Notice('Command copied'),
					() => new Notice('Could not copy to clipboard.'),
				);
			});
		}
		return hintEl;
	}

	// --- Retrieval and misc ------------------------------------------------------------------

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

	addEmbeddingCacheSetting(container: HTMLElement) {
		new Setting(container)
			.setName('Cache embeddings on disk')
			.setDesc('Faster loading when using a large vault for your Mini-RAG context. Cache is stored under the plugin folder.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.embeddingCacheEnabled)
				.onChange(async (value) => {
					this.plugin.settings.embeddingCacheEnabled = value;
					await this.plugin.saveSettings();
				})
			);
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
		// Supersede any refresh still in flight, and let this render's own refresh start.
		this.renderSeq++;
		this.isLoadingModels = false;
		this.modelDropdown = null;
		this.modelSetting = null;
		this.modelStatusEl = null;
		this.connectionStatusEl = null;
		this.chatHintEl = null;
		this.embeddingDropdown = null;
		this.embeddingDropdownContainerEl = null;
		this.embeddingStatusEl = null;
		this.embeddingSettingEl = null;
		this.embeddingHintEl = null;
		// Lists belong to whichever provider was active; a switch must not offer the old one's.
		this.installedModels = [];
		this.listedEmbeddingModels = [];
		this.embeddingListFailure = null;
		// display() always starts a fresh listing, below.
		this.embeddingLoading = true;

		// Set up in steps: the provider, then its server and models, then the shared tuning. Step 2
		// is named after the provider, so a switch visibly changes that step and no other.
		this.addHeading(containerEl, '1. Choose a provider');
		this.addProviderSelector(containerEl);

		const connect = this.addHeading(containerEl, `2. Connect to ${this.providerName}`);
		this.connectionStatusEl = connect.controlEl.createSpan({cls: CSS_CLASS_PREFIX + 'connection-status'});
		this.addServerUrl(containerEl);
		this.addModelSelector(containerEl);
		this.addEmbeddingModelSetting(containerEl);

		this.addHeading(containerEl, '3. Tune your chats');
		this.addHyperParameterTemperature(containerEl);
		this.addRagTopKSetting(containerEl);
		this.addEnableContextFreeChats(containerEl);
		this.addEmbeddingCacheSetting(containerEl);
		void this.refreshModelList();
	}
}
