declare module 'electron' {
	interface Clipboard {
		writeText(text: string): void;
	}
	export const clipboard: Clipboard;
}
