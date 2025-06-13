import {TAbstractFile, TFile, TFolder, Vault} from "obsidian";

export class FileManager {
	vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	isFile(abstractFile: TAbstractFile) {
		return (abstractFile instanceof TFile)
	}

	isFolderPath(path: string): boolean {
		return this.vault.getFolderByPath(path) != null;
	}

	async createFile(filepath: string, content: string) {
		await this.vault.create(filepath, content);
	}

	async createFolder(folderPath: string) {
		await this.vault.createFolder(folderPath);
	}

	async readFileText(filePath: string){
		const file = this.vault.getFileByPath(filePath)
		return !file ? "" : await this.vault.read(file);
	}

	readFilenameWithoutExtension(file: TAbstractFile){
		if(this.isFile(file)){
			return file.name.slice(0, file.name.lastIndexOf("."));
		}else{
			return file.name;//Return everything, it's a folder
		}
	}

	async updateFile(path: string, content: string) {
		const file = this.vault.getFileByPath(path)
		if(!file) {//File does not exist
			await this.createFile(path, content);
		}else{//File exists
			await this.vault.modify(file, content);
		}
	}
}
