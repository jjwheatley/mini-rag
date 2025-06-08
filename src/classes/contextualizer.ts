import OllamaPlugin from "../../main";
import {TAbstractFile, TFile, TFolder} from "obsidian";

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

	async addFolderToContext(folder: TFolder){
		const files = this.recurseChildren(folder);
		for (const f of files){
			await this.addFileToContext(f)
		}
	}

	recurseChildren(file: TAbstractFile){
		const res: TFile[] = []
		if(file instanceof TFolder){
			for (const f of file.children) {
				if(f instanceof TFile){
					res.push(f);
				}else{
					res.push(...this.recurseChildren(f))
				}
			}
		}else if(file instanceof TFile){
			res.push(file)
		}
		return res;
	}
}
