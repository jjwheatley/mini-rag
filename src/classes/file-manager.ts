import {TAbstractFile, TFile, Vault} from "obsidian";

export class FileManager {
	vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	isFile(abstractFile: TAbstractFile) {
		return (abstractFile instanceof TFile);
	}

	isFolderPath(path: string): boolean {
		return this.vault.getFolderByPath(path) != null;
	}

	fileExists(path: string): boolean {
		return this.vault.getFileByPath(path) != null;
	}

	/** Returns path unchanged, or adds " (n)" before the extension if the file already exists. */
	resolveUniqueFilePath(path: string): string {
		if (!this.fileExists(path)) {
			return path;
		}

		const lastSlash = path.lastIndexOf('/');
		const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
		const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
		const dotIndex = filename.lastIndexOf('.');
		const stem = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
		const ext = dotIndex >= 0 ? filename.slice(dotIndex) : '';

		let counter = 2;
		let candidate = `${dir}${stem} (${counter})${ext}`;
		while (this.fileExists(candidate)) {
			counter++;
			candidate = `${dir}${stem} (${counter})${ext}`;
		}
		return candidate;
	}

	async createFile(filepath: string, content: string) {
		await this.vault.create(filepath, content);
	}

	async createFolder(folderPath: string) {
		await this.vault.createFolder(folderPath);
	}

	async readFileText(filePath: string) {
		const file = this.vault.getFileByPath(filePath)
		return !file ? "" : await this.vault.cachedRead(file);
	}

	readFilenameWithoutExtension(file: TAbstractFile) {
		if (this.isFile(file)) {
			return file.name.slice(0, file.name.lastIndexOf("."));
		} else {
			return file.name; // Return everything, it's a folder
		}
	}

	async updateFile(path: string, content: string) {
		const file = this.vault.getFileByPath(path);
		if (!file) {
			await this.createFile(path, content);
		} else {
			await this.vault.modify(file, content);
		}
	}
}
