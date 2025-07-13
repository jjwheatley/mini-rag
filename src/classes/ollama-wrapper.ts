import {requestUrl} from "obsidian";
import OllamaPlugin from "../../main";
import {CONTEXT_TEMPLATE, OLLAMA_API} from "../constants";

export class OllamaWrapper{
	plugin: OllamaPlugin;
	context: number[]

	constructor(plugin: OllamaPlugin, initialContext?: string) {
		this.plugin = plugin;
		if(initialContext && initialContext.length > 0){
			this.sendInitialContext(initialContext)
		}
	}

	sendInitialContext(initialContext: string){
		const prompt = CONTEXT_TEMPLATE + initialContext
		this.plugin.getChatWindow().then(c => {
			c.setDisabledState(true)
			this.sendQuestion(prompt).then(
				() => c.setDisabledState(false)
			);
		})
	}

	async getModelList(){
		const output = await requestUrl({
			method: "GET",
			url: `${this.plugin.settings.ollamaURL}${OLLAMA_API.tags}`,
		}).then(result => result.json.models.map((model: { name: string; }) => model.name))

		output.sort((a: string, b:string) => a.localeCompare(b));
		return output
	}

	async sendQuestion(question: string) {
		let output: string = ''

		await requestUrl({
			method: "POST",
			url: `${this.plugin.settings.ollamaURL}${OLLAMA_API.generate}`,
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
