/** Stub for the `electron` module, aliased in by vitest.config.mts. */
import {vi} from 'vitest';

export const clipboard = {
	writeText: vi.fn<(text: string) => void>(),
	readText: vi.fn<() => string>(() => ''),
};
