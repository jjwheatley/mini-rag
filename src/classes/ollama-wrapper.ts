import {requestUrl} from "obsidian";
import {PluginSettings} from "../types";

export class OllamaWrapper{
	settings: PluginSettings;
	context: number[]

	constructor(settings: PluginSettings, initialContext?: string) {
		this.settings = settings;
		if(initialContext && initialContext.length > 0){
			this.setupInitialContext(initialContext)
		}
	}

	setupInitialContext(initialContext: string){
		let prompt = "The following text may be referred to as a 'file', 'markdown file', 'text', 'document', etc. For this chat, you will use the text as context. \n"
		prompt+= "\n\n\n The Text: " + initialContext + "\n"
		this.askQuestion(prompt).then();
	}

	async getModelList(){
		let output: string[] = []

		await requestUrl({
			method: "GET",
			url: `${this.settings.ollamaURL}/api/tags`,
		}).then(result => {
			output = result.json.models.map((model: { name: string; }) => model.name)
		})

		return output
	}

	async askQuestion(question: string) {
		let output: string = ''

		await requestUrl({
			method: "POST",
			url: `${this.settings.ollamaURL}/api/generate`,
			body: JSON.stringify({
				prompt: question,
				context: this.context,
				model: this.settings.aiModel,
				options: {
					temperature: this.settings.temperature
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
