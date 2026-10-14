import {App, Modal, Setting} from "obsidian";
import {addFundingButtons, FundingLink, SUPPORT_TEXT, SUPPORT_TITLE} from "../../support";
import {CSS_CLASS_PREFIX} from "../../constants";

/** What the "Support development" command opens: what support is for, and a button for each link. */
export class SupportModal extends Modal {
	constructor(app: App, private readonly links: FundingLink[]) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(SUPPORT_TITLE);
		this.contentEl.createEl('p', {text: SUPPORT_TEXT, cls: CSS_CLASS_PREFIX + 'support-text'});
		// Once a page is open there is nothing more to do here.
		addFundingButtons(new Setting(this.contentEl), this.links, () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
