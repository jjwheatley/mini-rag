
export class ChatLoadingAnimation {
	htmlElement: HTMLSpanElement;

	constructor(parent: Element) {
		this.htmlElement = parent.createEl("span", {cls: "loader"});
	}

	show(){
		this.htmlElement.classList.remove("hidden");
	}

	hide() {
		this.htmlElement.classList.add("hidden");
	}
}
