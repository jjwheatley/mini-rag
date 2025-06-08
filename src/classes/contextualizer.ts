import OllamaPlugin from "../../main";
import {TAbstractFile} from "obsidian";


export class Contextualizer {
	plugin: OllamaPlugin;
	contextPaths: Map<string, string>;


	constructor(plugin: OllamaPlugin) {
		this.plugin = plugin;
		this.contextPaths = new Map();
	}

	async addFileToContext(file: TAbstractFile){
		if(!this.contextPaths.has(file.path)){
			const context = await this.plugin.fileManager.readFileText(file.path);
			this.contextPaths.set(file.path, context);
		}
	}

	getContextAsText(){
		const results = []
		for (const x of this.contextPaths.values()) {
			results.push(x);
		}
		return results.join('\n\n');
	}

	// ToDo: Check folder exists, walk it & add content to context using "addFileToContext"
	// addFolderToContext(folderPath: string){}
}
