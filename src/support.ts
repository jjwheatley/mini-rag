import {setIcon, Setting} from "obsidian";
import {CSS_CLASS_PREFIX} from "./constants";

/** Somewhere to support Mini-RAG: the name on its button, and the page it opens. */
export interface FundingLink {
	name: string;
	url: string;
}

export const SUPPORT_TITLE = 'Support Mini-RAG';
/**
 * The greeting has a line of its own; where the text is shown, `white-space: pre-line` keeps that
 * break.
 */
export const SUPPORT_TEXT = 'Hi,\nMini-RAG is a one-man project. If you like what it does, please consider a monthly sponsorship '
	+ 'or a one-off tip to buy me a coffee.';

/**
 * "Support Mini-RAG ♡": the title with the heart after it, so it lines up with the text below it.
 * The settings banner and the chat panel's support menu both use it, so they read as one thing.
 */
export function supportTitle(): DocumentFragment {
	const title = document.createDocumentFragment();
	title.appendText(SUPPORT_TITLE);
	const heart = title.createSpan({cls: CSS_CLASS_PREFIX + 'support-heart'});
	setIcon(heart, 'heart');
	return title;
}

/** Only web pages: anything else in the manifest is a mistake, not somewhere to send people. */
const isWebLink = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url);

/**
 * The links in the manifest's fundingUrl, which is one URL or names mapped to URLs. Obsidian's
 * manifest type leaves the field out, so it arrives as unknown.
 */
export function fundingLinks(fundingUrl: unknown): FundingLink[] {
	if (isWebLink(fundingUrl)) return [{name: 'Support', url: fundingUrl}];
	if (!fundingUrl || typeof fundingUrl !== 'object') return [];
	return Object.entries(fundingUrl)
		.filter((entry): entry is [string, string] => isWebLink(entry[1]))
		.map(([name, url]) => ({name, url}));
}

/** Opens a funding link in the browser. */
export function openFundingLink(link: FundingLink): void {
	window.open(link.url);
}

/** A button for each link on `setting`, the first as the main one. */
export function addFundingButtons(setting: Setting, links: FundingLink[], afterOpen?: () => void): Setting {
	links.forEach((link, index) => setting.addButton(button => {
		button.setButtonText(link.name).onClick(() => {
			openFundingLink(link);
			afterOpen?.();
		});
		if (index === 0) button.setCta();
	}));
	return setting;
}

/** The settings tab's support row: what support is for, and a button for each link. None without links. */
export function addSupportSetting(container: HTMLElement, links: FundingLink[]): void {
	if (links.length === 0) return;
	const setting = new Setting(container)
		.setName(supportTitle())
		.setDesc(SUPPORT_TEXT)
		.setClass(CSS_CLASS_PREFIX + 'support');
	addFundingButtons(setting, links);
}
