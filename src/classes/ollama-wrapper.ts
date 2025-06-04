import {requestUrl} from "obsidian";
import {PluginSettings} from "../types";

export class OllamaWrapper{
	settings: PluginSettings;
	temperature: number
	context: number[]

	constructor(settings: PluginSettings) {
		this.settings = settings;
		this.temperature = 0.1; // ToDo: Make configurable in settings
		console.log(this.settings.aiModal)
	}

	async askQuestion(question: string) {
		let output: string = ''

		await requestUrl({
			method: "POST",
			url: `${this.settings.ollamaURL}/api/generate`,
			body: JSON.stringify({
				prompt: question,
				context: this.context,
				model: this.settings.aiModal,
				options: {
					temperature: this.temperature
				},
				stream: false,
			}),
		}).then(result => {
			output = result.json.response
			this.context = result.json.context
		})

		return output
	}

}
