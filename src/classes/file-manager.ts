import {TAbstractFile, Vault} from "obsidian";

export class FileManager {
	vault: Vault;
	constructor(vault: Vault) {
		this.vault = vault;
	}

	isFolderPath(path: string): boolean {
		return this.vault.getFolderByPath(path) != null;
	}

	async createFolder(path: string) {
		await this.vault.createFolder(path);
	}

	async deleteFileIfExists(path: string) {
		const file = this.vault.getFileByPath(path)
		if(file) {
			await this.vault.delete(file)
		}
	}

	isMarkdownFilename(filename: string) {
		return filename.endsWith(".md");
	}

	async getFileText(contextFilePath: string){
		const file = this.vault.getFileByPath(contextFilePath)
		return !file ? "" : await this.vault.read(file);
	}

	getFilenameWithoutExtension(file: TAbstractFile){
		const isMarkdownFile = this.isMarkdownFilename(file.name)
		if(isMarkdownFile){
			return file.name.slice(0,-3)
		}else{
			return file.name;
		}
	}
}
