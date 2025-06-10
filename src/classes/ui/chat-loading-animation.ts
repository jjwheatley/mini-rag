import {CSS_CLASS_PREFIX} from "../../constants";

export class ChatLoadingAnimation {
	htmlElement: HTMLSpanElement;

	constructor(parent: Element) {
		this.htmlElement = parent.createEl("span", {cls: CSS_CLASS_PREFIX+"Loader"});
	}

	show(){
		this.htmlElement.classList.remove("hidden");
	}

	hide() {
		this.htmlElement.classList.add("hidden");
	}
}
