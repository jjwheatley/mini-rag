import {requestUrl} from "obsidian";
import OllamaPlugin from "../../main";

export class OllamaWrapper{
	plugin: OllamaPlugin;
	context: number[]

	constructor(plugin: OllamaPlugin, initialContext?: string) {
		this.plugin = plugin;
		if(initialContext && initialContext.length > 0){
			this.setupInitialContext(initialContext)
		}
	}

	setupInitialContext(initialContext: string){
		let prompt = "The following text may be referred to as a 'file', 'markdown file', 'text', 'document', etc. For this chat, you will use the text as context. \n"
		prompt+= "\n\n\n The Text: " + initialContext + "\n"

		this.plugin.view.disableInput(); //ToDo: Add a loading gif or something & remove when input is enabled again
		this.askQuestion(prompt).then(
			() => this.plugin.view.enableInput()
		);
	}

	async getModelList(){
		let output: string[] = []

		await requestUrl({
			method: "GET",
			url: `${this.plugin.settings.ollamaURL}/api/tags`,
		}).then(result => {
			output = result.json.models.map((model: { name: string; }) => model.name)
		})

		return output
	}

	async askQuestion(question: string) {
		let output: string = ''

		await requestUrl({
			method: "POST",
			url: `${this.plugin.settings.ollamaURL}/api/generate`,
			body: JSON.stringify({
				prompt: question,
				context: this.context,
				model: this.plugin.settings.aiModel,
				options: {
					temperature: this.plugin.settings.temperature
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
