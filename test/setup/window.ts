/**
 * Obsidian runs in a browser window, where `window` is the global object, and the plugin calls its
 * timers through it (`window.setTimeout`) so that they keep working in popout windows. The node
 * environment has no window, so here it gets one: the global object itself, as jsdom's environment
 * already arranges. Fake timers patch the global object, so they apply through `window` as well.
 * Registered as a vitest setup file for every test.
 */
if (typeof window === 'undefined') {
	Object.defineProperty(globalThis, 'window', {value: globalThis, configurable: true, writable: true});
}
