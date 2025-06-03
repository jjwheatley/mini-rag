import { requestUrl } from "obsidian";
import {PluginSettings} from "../types";

export class OllamaWrapper{

	settings: PluginSettings;
	temperature: number

	constructor(settings: PluginSettings) {
		this.settings = settings;
		this.temperature = 0.1;
		console.log(this.settings.aiModal)
	}

	async askQuestion(question: string) {
		let output: string = ''

		await requestUrl({
			method: "POST",
			url: `${this.settings.ollamaURL}/api/generate`,
			body: JSON.stringify({
				prompt: question,
				model: this.settings.aiModal,
				options: {
					temperature: this.temperature
				},
			}),
		}).then(result => {
			output = result.text
				.split("\n")
				.filter((item) => item && item.length > 0)
				.map((item) => JSON.parse(item).response)
				.join("")
				.trim();
		})

		return output
	}

}
