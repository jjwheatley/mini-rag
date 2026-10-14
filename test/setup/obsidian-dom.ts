/**
 * Obsidian patches a set of convenience helpers onto Element/Node at runtime — createEl, empty,
 * setText and friends. They are not part of the DOM, so under jsdom they must be installed before
 * any UI module runs. Registered as a vitest setup file for the jsdom project.
 *
 * These reproduce the documented behaviour of each helper, not Obsidian's implementation. Keep
 * them faithful: a helper that behaves differently here makes tests pass while the plugin breaks.
 */

export interface DomElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
}

function applyClasses(el: Element, cls?: string | string[]): void {
	if (!cls) return;
	const classes = Array.isArray(cls) ? cls : cls.split(/\s+/);
	for (const name of classes) {
		if (name) el.classList.add(name);
	}
}

function applyInfo(el: HTMLElement, info?: DomElementInfo | string): void {
	if (info === undefined) return;
	if (typeof info === 'string') {
		applyClasses(el, info);
		return;
	}

	applyClasses(el, info.cls);
	if (info.text !== undefined) {
		if (typeof info.text === 'string') {
			el.textContent = info.text;
		} else {
			el.appendChild(info.text);
		}
	}
	if (info.title !== undefined) el.setAttribute('title', info.title);
	if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
	if (info.type !== undefined) el.setAttribute('type', info.type);
	if (info.placeholder !== undefined) el.setAttribute('placeholder', info.placeholder);
	if (info.href !== undefined) el.setAttribute('href', info.href);
	if (info.attr) {
		for (const [key, value] of Object.entries(info.attr)) {
			if (value === null || value === false) {
				el.removeAttribute(key);
			} else {
				el.setAttribute(key, String(value));
			}
		}
	}
}

function createChild(
	parent: Node,
	tag: string,
	info?: DomElementInfo | string,
): HTMLElement {
	const el = parent.ownerDocument?.createElement(tag) ?? document.createElement(tag);
	applyInfo(el, info);
	parent.appendChild(el);
	return el;
}

export function installObsidianDomHelpers(): void {
	const nodeProto = Node.prototype as unknown as Record<string, unknown>;
	const elProto = Element.prototype as unknown as Record<string, unknown>;

	const define = (proto: Record<string, unknown>, name: string, value: unknown) => {
		Object.defineProperty(proto, name, {value, writable: true, configurable: true});
	};

	define(nodeProto, 'createEl', function (this: Node, tag: string, info?: DomElementInfo | string) {
		return createChild(this, tag, info);
	});
	define(nodeProto, 'createDiv', function (this: Node, info?: DomElementInfo | string) {
		return createChild(this, 'div', info);
	});
	define(nodeProto, 'createSpan', function (this: Node, info?: DomElementInfo | string) {
		return createChild(this, 'span', info);
	});
	define(nodeProto, 'appendText', function (this: Node, text: string) {
		this.appendChild((this.ownerDocument ?? document).createTextNode(text));
	});

	define(elProto, 'empty', function (this: Element) {
		while (this.firstChild) this.removeChild(this.firstChild);
	});
	define(elProto, 'detach', function (this: Element) {
		this.parentNode?.removeChild(this);
	});
	define(elProto, 'setText', function (this: Element, text: string | DocumentFragment) {
		if (typeof text === 'string') {
			this.textContent = text;
		} else {
			this.textContent = '';
			this.appendChild(text);
		}
	});
	define(elProto, 'addClass', function (this: Element, ...classes: string[]) {
		for (const name of classes) this.classList.add(name);
	});
	define(elProto, 'removeClass', function (this: Element, ...classes: string[]) {
		for (const name of classes) this.classList.remove(name);
	});
	define(elProto, 'toggleClass', function (this: Element, classes: string | string[], value: boolean) {
		for (const name of Array.isArray(classes) ? classes : [classes]) {
			this.classList.toggle(name, value);
		}
	});
	define(elProto, 'hasClass', function (this: Element, name: string) {
		return this.classList.contains(name);
	});
	define(elProto, 'setAttr', function (this: Element, key: string, value: string | number | boolean | null) {
		if (value === null || value === false) {
			this.removeAttribute(key);
		} else {
			this.setAttribute(key, String(value));
		}
	});

	// Obsidian's show/hide toggle an "is-hidden" class rather than inline display.
	define(elProto, 'show', function (this: HTMLElement) {
		this.classList.remove('is-hidden');
		this.style.removeProperty('display');
	});
	define(elProto, 'hide', function (this: HTMLElement) {
		this.classList.add('is-hidden');
		this.style.setProperty('display', 'none');
	});
	define(elProto, 'isShown', function (this: HTMLElement) {
		return !this.classList.contains('is-hidden');
	});
}

installObsidianDomHelpers();
