import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TFile as StubTFile, TFolder as StubTFolder} from './stubs/obsidian';
import type {TAbstractFile, TFile, TFolder, Vault} from 'obsidian';
import {FileManager} from '../src/classes/file-manager';

// The stub classes are what `instanceof TFile` compares against at runtime, since vitest aliases
// the obsidian module to them; tsc resolves that module to the real typings. One cast bridges the
// two views so call sites stay typed.
function makeFile(path: string): TFile {
	const file = new StubTFile();
	file.path = path;
	file.name = path.split('/').pop() ?? path;
	return file as unknown as TFile;
}

function makeFolder(path: string): TFolder {
	const folder = new StubTFolder();
	folder.path = path;
	folder.name = path.split('/').pop() ?? path;
	return folder as unknown as TFolder;
}

/** An in-memory vault recording every mutation. */
function makeVault() {
	const files = new Map<string, string>();
	const folders = new Set<string>();

	const vault = {
		getFileByPath: vi.fn((path: string) => (files.has(path) ? makeFile(path) : null)),
		getFolderByPath: vi.fn((path: string) => (folders.has(path) ? makeFolder(path) : null)),
		create: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		createFolder: vi.fn(async (path: string) => {
			folders.add(path);
		}),
		cachedRead: vi.fn(async (file: TFile) => files.get(file.path) ?? ''),
		modify: vi.fn(async (file: TFile, content: string) => {
			files.set(file.path, content);
		}),
	};

	return {vault, files, folders, manager: new FileManager(vault as unknown as Vault)};
}

let harness: ReturnType<typeof makeVault>;

beforeEach(() => {
	harness = makeVault();
});

describe('isFile', () => {
	it('recognises a file', () => {
		expect(harness.manager.isFile(makeFile('a.md') as TAbstractFile)).toBe(true);
	});

	it('rejects a folder', () => {
		expect(harness.manager.isFile(makeFolder('notes') as TAbstractFile)).toBe(false);
	});
});

describe('existence checks', () => {
	it('reports a folder that exists', () => {
		harness.folders.add('notes');
		expect(harness.manager.isFolderPath('notes')).toBe(true);
	});

	it('reports a folder that does not', () => {
		expect(harness.manager.isFolderPath('missing')).toBe(false);
	});

	it('reports a file that exists', () => {
		harness.files.set('a.md', 'body');
		expect(harness.manager.fileExists('a.md')).toBe(true);
	});

	it('reports a file that does not', () => {
		expect(harness.manager.fileExists('a.md')).toBe(false);
	});
});

describe('resolveUniqueFilePath', () => {
	it('returns the path unchanged when nothing is there', () => {
		expect(harness.manager.resolveUniqueFilePath('Chats/note.md')).toBe('Chats/note.md');
	});

	it('appends (2) on the first collision', () => {
		harness.files.set('Chats/note.md', 'x');
		expect(harness.manager.resolveUniqueFilePath('Chats/note.md')).toBe('Chats/note (2).md');
	});

	it('counts up past consecutive collisions', () => {
		harness.files.set('Chats/note.md', 'x');
		harness.files.set('Chats/note (2).md', 'x');
		harness.files.set('Chats/note (3).md', 'x');

		expect(harness.manager.resolveUniqueFilePath('Chats/note.md')).toBe('Chats/note (4).md');
	});

	it('inserts the counter before the extension, not after', () => {
		harness.files.set('a.md', 'x');
		expect(harness.manager.resolveUniqueFilePath('a.md')).toBe('a (2).md');
	});

	it('handles a path with no directory', () => {
		harness.files.set('note.md', 'x');
		expect(harness.manager.resolveUniqueFilePath('note.md')).toBe('note (2).md');
	});

	it('handles a file with no extension', () => {
		harness.files.set('Chats/README', 'x');
		expect(harness.manager.resolveUniqueFilePath('Chats/README')).toBe('Chats/README (2)');
	});

	it('uses only the last dot, so a dotted stem survives', () => {
		harness.files.set('Chats/notes.v2.md', 'x');
		expect(harness.manager.resolveUniqueFilePath('Chats/notes.v2.md')).toBe('Chats/notes.v2 (2).md');
	});

	it('preserves a nested directory', () => {
		harness.files.set('a/b/c.md', 'x');
		expect(harness.manager.resolveUniqueFilePath('a/b/c.md')).toBe('a/b/c (2).md');
	});

	it('treats a leading-dot filename as all extension', () => {
		harness.files.set('.gitignore', 'x');
		expect(harness.manager.resolveUniqueFilePath('.gitignore')).toBe(' (2).gitignore');
	});
});

describe('readFileText', () => {
	it('reads an existing file', async () => {
		harness.files.set('a.md', 'the body');
		expect(await harness.manager.readFileText('a.md')).toBe('the body');
	});

	// Callers treat a missing note as empty context rather than an error.
	it('returns an empty string for a missing file, without reading', async () => {
		expect(await harness.manager.readFileText('missing.md')).toBe('');
		expect(harness.vault.cachedRead).not.toHaveBeenCalled();
	});

	it('uses cachedRead rather than a full read', async () => {
		harness.files.set('a.md', 'body');
		await harness.manager.readFileText('a.md');

		expect(harness.vault.cachedRead).toHaveBeenCalledTimes(1);
	});
});

describe('readFilenameWithoutExtension', () => {
	it('strips the extension from a file', () => {
		expect(harness.manager.readFilenameWithoutExtension(makeFile('notes/a.md') as TAbstractFile)).toBe('a');
	});

	it('strips only the last extension', () => {
		expect(harness.manager.readFilenameWithoutExtension(makeFile('a.v2.md') as TAbstractFile)).toBe('a.v2');
	});

	it('keeps a folder name whole', () => {
		expect(harness.manager.readFilenameWithoutExtension(makeFolder('notes/sub') as TAbstractFile)).toBe('sub');
	});

	// Latent bug, pinned rather than fixed: with no dot, lastIndexOf returns -1 and slice(0, -1)
	// drops the final character instead of returning the name whole. Unreached today because
	// context files are always .md, but a fix should be a deliberate change to this expectation.
	it('drops the last character of an extensionless file', () => {
		expect(harness.manager.readFilenameWithoutExtension(makeFile('README') as TAbstractFile)).toBe('READM');
	});
});

describe('createFile / createFolder', () => {
	it('creates a file with its content', async () => {
		await harness.manager.createFile('a.md', 'body');

		expect(harness.vault.create).toHaveBeenCalledWith('a.md', 'body');
		expect(harness.files.get('a.md')).toBe('body');
	});

	it('creates a folder', async () => {
		await harness.manager.createFolder('Chats');

		expect(harness.vault.createFolder).toHaveBeenCalledWith('Chats');
		expect(harness.folders.has('Chats')).toBe(true);
	});
});

describe('updateFile', () => {
	it('creates the file when it does not exist', async () => {
		await harness.manager.updateFile('a.md', 'body');

		expect(harness.vault.create).toHaveBeenCalledWith('a.md', 'body');
		expect(harness.vault.modify).not.toHaveBeenCalled();
	});

	it('modifies the file when it exists', async () => {
		harness.files.set('a.md', 'old');

		await harness.manager.updateFile('a.md', 'new');

		expect(harness.vault.modify).toHaveBeenCalled();
		expect(harness.vault.create).not.toHaveBeenCalled();
		expect(harness.files.get('a.md')).toBe('new');
	});
});
