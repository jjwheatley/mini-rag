import {TAbstractFile, Vault} from "obsidian";

export class FileManager {
	vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	isFolderPath(path: string): boolean {
		return this.vault.getFolderByPath(path) != null;
	}

	isExtensionMarkdown(filename: string) {
		return filename.endsWith(".md");
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
		if(this.isExtensionMarkdown(file.name)){
			return file.name.slice(0,-3)
		}else{
			return file.name;
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
