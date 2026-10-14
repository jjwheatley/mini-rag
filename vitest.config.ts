import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// `obsidian` and `electron` are esbuild externals at build time — they only exist inside the
// Obsidian app. Alias them to hand-written stubs so modules that import them can be loaded
// headlessly. `electron` is needed because chat-window.ts and chat-conversation-window.ts
// import `clipboard` from it at module scope.
const stub = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
	resolve: {
		// Source first. The build writes main.js beside main.ts, and Vite's default order puts .js
		// ahead of .ts -- so an extensionless import of '../main' would silently load the stale
		// bundle instead of the code under test.
		extensions: ['.ts', '.mts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
		alias: {
			obsidian: stub('./test/stubs/obsidian.ts'),
			electron: stub('./test/stubs/electron.ts'),
		},
	},
	test: {
		// No jsdom: ReadableStream, TextDecoder, AbortController and DOMException are all Node
		// globals, and the DOM-bound UI classes are deliberately not unit-tested.
		environment: 'node',
		include: ['test/**/*.test.ts'],
		globals: false,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			reportsDirectory: 'coverage',
			// Listed explicitly: Vitest 3 removed `coverage.all`, so without this only files a
			// test happens to import appear, and the percentages stop meaning anything.
			include: ['main.ts', 'src/**/*.ts'],
			// Type declarations and barrels carry no runtime behaviour to cover.
			exclude: [
				'src/electron.d.ts',
				'src/types.ts',
				'src/constants.ts',
				'src/providers/types.ts',
				'src/providers/index.ts',
			],
			// Every file is covered, including the Obsidian-DOM UI (via jsdom plus the helper shim
			// in test/setup/obsidian-dom.ts). The global floor sits just under the achieved level so
			// any regression fails the build; the per-glob gates pin the files where a slip would
			// matter most. Files matched by a glob key are excluded from the global calculation.
			thresholds: {
				// Ratcheted up as each suite lands; see the commit table in the plan.
				lines: 99,
				functions: 100,
				statements: 99,
				branches: 97,
				'src/utils.ts': {lines: 95, functions: 95, statements: 95, branches: 85},
				'src/chunker.ts': {lines: 100, functions: 100, statements: 100, branches: 90},
				'src/prompt.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/summarize.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/settings.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/settings-migration.ts': {lines: 100, functions: 100, statements: 100, branches: 95},
				'src/defaults.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/vector-index.ts': {lines: 100, functions: 100, statements: 100, branches: 90},
				'src/classes/contextualizer.ts': {lines: 95, functions: 100, statements: 95, branches: 90},
				'src/classes/index-build.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/file-manager.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/chat-messages.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/chat-input.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/chat-buttons.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/chat-loading-animation.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/chat-conversation-window.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/chat-window.ts': {lines: 98, functions: 100, statements: 98, branches: 95},
				'src/classes/settings-tab.ts': {lines: 98, functions: 100, statements: 98, branches: 92},
				'src/classes/menu-manager.ts': {lines: 100, functions: 100, statements: 100, branches: 100},
				'src/classes/ui/save-chat-as-modal.ts': {lines: 100, functions: 100, statements: 100, branches: 90},
				'main.ts': {lines: 100, functions: 100, statements: 100, branches: 95},
				'src/providers/**': {lines: 98, functions: 100, statements: 98, branches: 95},
			},
		},
	},
});
