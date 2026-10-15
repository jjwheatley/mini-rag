/**
 * Hand-written stub for the `obsidian` module, aliased in by vitest.config.mts.
 *
 * Anything a module-under-test evaluates at import time needs a real class here
 * (`class ChatWindow extends ItemView` runs at load). Keep this minimal — grow it only when a
 * test actually forces you to, so the stub never drifts into a second implementation.
 */
import {vi} from 'vitest';

// ---------------------------------------------------------------------------
// requestUrl
// ---------------------------------------------------------------------------

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	/** Obsidian defaults this to true: a status >= 400 throws rather than returning. */
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

export type RequestUrlHandler = (
	request: RequestUrlParam,
) => Partial<RequestUrlResponse> | Promise<Partial<RequestUrlResponse>>;

const noHandler: RequestUrlHandler = request => {
	throw new Error(`requestUrl stub: no handler installed (called with ${request.url})`);
};

let handler: RequestUrlHandler = noHandler;

/** Every request the code under test made, in order, for body/URL assertions. */
export const requestUrlCalls: RequestUrlParam[] = [];

export function __setRequestUrlHandler(next: RequestUrlHandler): void {
	handler = next;
}

export function __resetRequestUrl(): void {
	requestUrlCalls.length = 0;
	handler = noHandler;
}

/** Convenience for body assertions: the parsed JSON body of the nth recorded call. */
export function __requestBody(index: number): any {
	const raw = requestUrlCalls[index]?.body;
	return typeof raw === 'string' ? JSON.parse(raw) : undefined;
}

function safeParse(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export const requestUrl = vi.fn(
	async (request: RequestUrlParam | string): Promise<RequestUrlResponse> => {
		const param: RequestUrlParam = typeof request === 'string' ? {url: request} : request;
		requestUrlCalls.push(param);

		const partial = await handler(param);
		const status = partial.status ?? 200;
		const text = partial.text ?? (partial.json !== undefined ? JSON.stringify(partial.json) : '');
		const response: RequestUrlResponse = {
			status,
			headers: partial.headers ?? {},
			text,
			json: partial.json !== undefined ? partial.json : (text ? safeParse(text) : undefined),
			arrayBuffer: partial.arrayBuffer ?? new ArrayBuffer(0),
		};

		// This throw is load-bearing: it is what the production `/status 501/` regex matches.
		// Getting it wrong would make the tests pass while real behaviour differs.
		if (status >= 400 && param.throw !== false) {
			throw new Error(`Request failed, status ${status}`);
		}
		return response;
	},
);

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/** Approximates Obsidian's normalizePath: backslashes to slashes, collapse runs, trim edges. */
export function normalizePath(path: string): string {
	const normalized = path
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.normalize('NFC');
	return normalized.length > 0 ? normalized : '/';
}

/** Records the icon's name on the element, so a test can check which icon was drawn. */
export function setIcon(element: unknown, iconId: string): void {
	(element as Element | undefined)?.setAttribute?.('data-icon', iconId);
}

export const MarkdownRenderer = {
	render: vi.fn(async () => {}),
};

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** Every Notice raised during a test, in order. Cleared by __resetNotices(). */
export const notices: string[] = [];

export function __resetNotices(): void {
	notices.length = 0;
}

export class Notice {
	constructor(public message: string | DocumentFragment, public duration?: number) {
		notices.push(String(message));
	}

	setMessage(message: string | DocumentFragment): this {
		this.message = message;
		return this;
	}

	hide(): void {}
}

export class Component {
	/** Children added via addChild, so a test can assert a panel's listeners were scoped. */
	children: unknown[] = [];
	/** Every listener registered through registerDomEvent, in order. */
	domEvents: {el: unknown; type: string; handler: EventListener}[] = [];

	addChild<T>(child: T): T {
		this.children.push(child);
		return child;
	}

	removeChild<T>(child: T): T {
		this.children = this.children.filter(c => c !== child);
		return child;
	}

	register(_cb: () => unknown): void {}

	/**
	 * Obsidian really does attach the listener (and unregisters it on unload), so the stub must
	 * too — otherwise a click test would silently exercise nothing.
	 */
	registerDomEvent(el: unknown, type: string, handler: EventListener): void {
		this.domEvents.push({el, type, handler});
		(el as EventTarget)?.addEventListener?.(type, handler);
	}

	registerEvent(): void {}

	load(): void {}

	onload(): void {}

	unload(): void {}

	onunload(): void {}
}

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
	vault!: Vault;
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = 'md';
	stat = {ctime: 0, mtime: 0, size: 0};
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === '/' || this.path === '';
	}
}

export class Vault {}

export class Workspace {}

export class WorkspaceLeaf {}

export class App {}

export class Plugin extends Component {
	constructor(public app?: any, public manifest?: any) {
		super();
	}

	addCommand<T>(command: T): T {
		return command;
	}

	addSettingTab(): void {}

	addRibbonIcon(): any {
		return {};
	}

	registerView(): void {}

	async loadData(): Promise<any> {
		return null;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
	containerEl: any;

	constructor(public app: any, public plugin: any) {
		this.containerEl = typeof document !== 'undefined' ? document.createElement('div') : {};
	}

	display(): void {}

	hide(): void {}
}

export class Modal {
	contentEl: any;
	titleEl: any;
	isOpen = false;

	constructor(public app: any) {
		this.contentEl = typeof document !== 'undefined' ? document.createElement('div') : {};
		this.titleEl = typeof document !== 'undefined' ? document.createElement('div') : {};
	}

	/** Obsidian calls onOpen as part of open(), so the stub must too. */
	open(): void {
		this.isOpen = true;
		this.onOpen();
	}

	close(): void {
		this.isOpen = false;
		this.onClose();
	}

	onOpen(): void {}

	onClose(): void {}
}

/** One entry of a Menu, capturing what was configured so a test can invoke it. */
export class MenuItem {
	title = '';
	icon = '';
	private clickHandler: (() => unknown) | null = null;
	checked = false;
	disabled = false;

	/** The title as given: text, or a fragment such as text followed by an icon. */
	titleContent: string | DocumentFragment = '';

	/**
	 * Under jsdom, the entry's element as Obsidian builds it: `.menu-item`, holding an icon slot and
	 * then the title. Null in the node environment.
	 */
	readonly dom: HTMLElement | null = typeof document !== 'undefined' ? menuItemDom() : null;

	/**
	 * Like Obsidian's, accepts text or a fragment; `title` keeps the text either way. A fragment's
	 * nodes move into the entry's title element, as they do in Obsidian.
	 */
	setTitle(title: string | DocumentFragment): this {
		this.titleContent = title;
		this.title = typeof title === 'string' ? title : title.textContent ?? '';
		this.dom?.querySelector('.menu-item-title')?.replaceChildren(title);
		return this;
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	setChecked(checked: boolean): this {
		this.checked = checked;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	/** Whether setIsLabel() made this a label: a heading, not something to click. */
	isLabel = false;

	setIsLabel(isLabel: boolean): this {
		this.isLabel = isLabel;
		return this;
	}

	onClick(handler: () => unknown): this {
		this.clickHandler = handler;
		return this;
	}

	/** Simulates the user picking this entry. */
	async click(): Promise<void> {
		await this.clickHandler?.();
	}
}

function menuItemDom(): HTMLElement {
	const dom = document.createElement('div');
	dom.className = 'menu-item tappable';
	for (const cls of ['menu-item-icon', 'menu-item-title']) {
		const child = document.createElement('div');
		child.className = cls;
		dom.appendChild(child);
	}
	return dom;
}

/** Every Menu constructed during a test, newest last. */
export const menus: Menu[] = [];

export function __resetMenus(): void {
	menus.length = 0;
}

export class Menu {
	items: MenuItem[] = [];
	separators = 0;
	shownAt: {x: number; y: number} | null = null;

	constructor() {
		menus.push(this);
	}

	addItem(callback: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		callback(item);
		this.items.push(item);
		return this;
	}

	addSeparator(): this {
		this.separators++;
		return this;
	}

	showAtPosition(position: {x: number; y: number}): this {
		this.shownAt = position;
		return this;
	}

	showAtMouseEvent(): this {
		this.shownAt = {x: 0, y: 0};
		return this;
	}

	/** Finds an entry by its title, for asserting and invoking it. */
	item(title: string): MenuItem | undefined {
		return this.items.find(i => i.title === title);
	}
}

/** Creates a detached element, or a plain object under the node environment. */
function stubEl(tag = 'div'): any {
	return typeof document !== 'undefined' ? document.createElement(tag) : {};
}

/**
 * Base for the value-carrying setting components. `trigger` is the test-facing half: it sets the
 * value the way the UI would and then runs the registered onChange, so a test drives the control
 * rather than calling the plugin's handler directly.
 */
class ValueComponentStub<T> {
	protected changeHandler: ((value: T) => unknown) | null = null;
	protected currentValue!: T;
	disabled = false;

	getValue(): T {
		return this.currentValue;
	}

	setValue(value: T): this {
		this.currentValue = value;
		return this;
	}

	onChange(handler: (value: T) => unknown): this {
		this.changeHandler = handler;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	/** Simulates the user changing this control, awaiting the async handler. */
	async trigger(value: T): Promise<void> {
		this.setValue(value);
		await this.changeHandler?.(value);
	}
}

export class TextComponent extends ValueComponentStub<string> {
	inputEl: any = stubEl('input');
	placeholder = '';

	constructor() {
		super();
		this.currentValue = '';
	}

	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		if (this.inputEl.setAttribute) this.inputEl.setAttribute('placeholder', placeholder);
		return this;
	}

	setValue(value: string): this {
		this.currentValue = value;
		this.inputEl.value = value;
		return this;
	}
}

export class TextAreaComponent extends TextComponent {}

export class ToggleComponent extends ValueComponentStub<boolean> {
	toggleEl: any = stubEl();

	constructor() {
		super();
		this.currentValue = false;
	}
}

export class SliderComponent extends ValueComponentStub<number> {
	sliderEl: any = stubEl('input');
	limits: {min: number; max: number; step: number} | null = null;

	constructor() {
		super();
		this.currentValue = 0;
	}

	setLimits(min: number, max: number, step: number): this {
		this.limits = {min, max, step};
		return this;
	}

	// No setDynamicTooltip(): Obsidian 1.13 deprecated it, since sliders now always show their value,
	// so a call to it fails here.
}

export class DropdownComponent extends ValueComponentStub<string> {
	selectEl: any = stubEl('select');

	constructor() {
		super();
		this.currentValue = '';
	}

	addOption(value: string, display: string): this {
		if (typeof document !== 'undefined') {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = display;
			this.selectEl.appendChild(option);
		}
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}

	setValue(value: string): this {
		this.currentValue = value;
		if (this.selectEl) this.selectEl.value = value;
		return this;
	}

	/** Every option value currently offered, including those inside optgroups. */
	optionValues(): string[] {
		if (typeof document === 'undefined') return [];
		return Array.from(this.selectEl.querySelectorAll('option')).map(
			(o: any) => o.getAttribute('value') ?? o.value,
		);
	}

	/** Option labels, in order. */
	optionLabels(): string[] {
		if (typeof document === 'undefined') return [];
		return Array.from(this.selectEl.querySelectorAll('option')).map((o: any) => o.textContent);
	}

	/** The optgroup labels, so grouping can be asserted. */
	groupLabels(): string[] {
		if (typeof document === 'undefined') return [];
		return Array.from(this.selectEl.querySelectorAll('optgroup')).map(
			(g: any) => g.getAttribute('label'),
		);
	}
}

export class ButtonComponent {
	buttonEl: any = stubEl('button');
	text = '';
	icon = '';
	tooltip = '';
	private clickHandler: ((event: MouseEvent) => unknown) | null = null;

	setButtonText(text: string): this {
		this.text = text;
		return this;
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}

	/** Whether setCta() made this the row's main button. */
	cta = false;

	setCta(): this {
		this.cta = true;
		return this;
	}

	onClick(handler: (event: MouseEvent) => unknown): this {
		this.clickHandler = handler;
		return this;
	}

	/** Simulates a click, awaiting the async handler. */
	async click(): Promise<void> {
		await this.clickHandler?.(new MouseEvent('click'));
	}
}

export class ExtraButtonComponent extends ButtonComponent {}

/** Every Setting row constructed during a test, in creation order. */
export const settingRows: Setting[] = [];

export function __resetSettings(): void {
	settingRows.length = 0;
}

/**
 * Finds the newest constructed row with this name. Newest, because a re-render builds fresh rows
 * while the old ones stay in this registry — and the fresh ones are what the user now sees.
 */
export function __setting(name: string): Setting | undefined {
	for (let i = settingRows.length - 1; i >= 0; i--) {
		if (settingRows[i].name === name) return settingRows[i];
	}
	return undefined;
}

/**
 * A Setting row. Builds real name/desc/control elements, because the plugin writes status text
 * into descEl directly, and invokes each add* callback synchronously as Obsidian does.
 */
export class Setting {
	settingEl: any;
	nameEl: any;
	descEl: any;
	controlEl: any;
	name = '';
	desc = '';
	/** Every component added to this row, in order. */
	components: unknown[] = [];
	/** Whether setHeading() made this a section heading rather than a setting. */
	isHeading = false;

	constructor(containerEl?: any) {
		this.settingEl = stubEl();
		this.nameEl = stubEl();
		this.descEl = stubEl();
		this.controlEl = stubEl();
		if (this.settingEl.appendChild) {
			this.settingEl.appendChild(this.nameEl);
			this.settingEl.appendChild(this.descEl);
			this.settingEl.appendChild(this.controlEl);
		}
		containerEl?.appendChild?.(this.settingEl);
		settingRows.push(this);
	}

	setName(name: string | DocumentFragment): this {
		this.name = typeof name === 'string' ? name : name.textContent ?? '';
		if (this.nameEl && typeof document !== 'undefined') {
			if (typeof name === 'string') {
				this.nameEl.textContent = name;
			} else {
				this.nameEl.replaceChildren(name);
			}
		}
		return this;
	}

	/**
	 * Like Obsidian's, this replaces everything in the description — including any element the
	 * plugin put there — rather than only recording the text.
	 */
	setDesc(desc: string | DocumentFragment): this {
		this.desc = String(desc);
		if (this.descEl && typeof document !== 'undefined') {
			if (typeof desc === 'string') {
				this.descEl.textContent = desc;
			} else {
				this.descEl.replaceChildren(desc);
			}
		}
		return this;
	}

	setClass(cls: string): this {
		this.settingEl?.classList?.add(cls);
		return this;
	}

	setHeading(): this {
		this.isHeading = true;
		// Obsidian's own class for a heading row.
		this.settingEl?.classList?.add('setting-item-heading');
		return this;
	}

	private add<T>(component: T, callback: (component: T) => unknown): this {
		this.components.push(component);
		// Obsidian mounts each control inside controlEl, so it is reachable from the container.
		const c = component as Record<string, any>;
		const el = c.inputEl ?? c.selectEl ?? c.sliderEl ?? c.toggleEl ?? c.buttonEl;
		if (el && this.controlEl?.appendChild) this.controlEl.appendChild(el);
		callback(component);
		return this;
	}

	addText(callback: (component: TextComponent) => unknown): this {
		return this.add(new TextComponent(), callback);
	}

	addTextArea(callback: (component: TextAreaComponent) => unknown): this {
		return this.add(new TextAreaComponent(), callback);
	}

	addToggle(callback: (component: ToggleComponent) => unknown): this {
		return this.add(new ToggleComponent(), callback);
	}

	addDropdown(callback: (component: DropdownComponent) => unknown): this {
		return this.add(new DropdownComponent(), callback);
	}

	addSlider(callback: (component: SliderComponent) => unknown): this {
		return this.add(new SliderComponent(), callback);
	}

	addButton(callback: (component: ButtonComponent) => unknown): this {
		return this.add(new ButtonComponent(), callback);
	}

	addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
		return this.add(new ExtraButtonComponent(), callback);
	}

	/** The first component of a given kind on this row. */
	component<T>(kind: new (...args: never[]) => T): T | undefined {
		return this.components.find(c => c instanceof kind) as T | undefined;
	}
}

export class ItemView extends Component {
	containerEl: any;
	/** Obsidian's own content container; a view's onOpen builds into this. */
	contentEl: any;
	/** Views reach through this for the workspace; overridable per test. */
	app: any = {workspace: {getActiveViewOfType: () => null}};
	icon = '';
	navigation = false;

	constructor(public leaf?: any) {
		super();
		// Guarded: this module also loads under the node environment, where there is no document.
		if (typeof document !== 'undefined') {
			this.containerEl = document.createElement('div');
			this.contentEl = this.containerEl.appendChild(document.createElement('div'));
			document.body.appendChild(this.containerEl);
		} else {
			this.containerEl = {};
			this.contentEl = {};
		}
	}

	getViewType(): string {
		return '';
	}

	getDisplayText(): string {
		return '';
	}

	getIcon(): string {
		return this.icon;
	}

	async onOpen(): Promise<void> {}

	async onClose(): Promise<void> {}
}
