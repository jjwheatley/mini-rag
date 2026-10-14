/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetSettings, ButtonComponent, settingRows} from '../stubs/obsidian';
import {SupportModal} from '../../src/classes/ui/support-modal';
import {SUPPORT_TEXT} from '../../src/support';
import {CSS_CLASS_PREFIX} from '../../src/constants';

// The second link is made up, so the tests can show more than one.
const LINKS = [
	{name: 'GitHub Sponsors', url: 'https://github.com/sponsors/jjwheatley'},
	{name: 'Tip jar', url: 'https://example.com/tip-jar'},
];

function open() {
	const modal = new SupportModal({} as never, LINKS);
	modal.open();
	return modal;
}

/** The buttons the modal offers, in order. */
const buttons = () => settingRows.flatMap(row => row.components.filter(c => c instanceof ButtonComponent)) as ButtonComponent[];

beforeEach(() => {
	__resetSettings();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// What the "Support development" command opens.
describe('SupportModal', () => {
	it('says what support is for', () => {
		const modal = open();

		expect(modal.titleEl.textContent).toBe('Support Mini-RAG');
		expect(modal.contentEl.textContent).toContain(SUPPORT_TEXT);
	});

	// The text breaks its line after the greeting; this class is what shows that break.
	it('keeps the text\'s line break', () => {
		const modal = open();

		expect(modal.contentEl.querySelector('p')?.classList.contains(`${CSS_CLASS_PREFIX}support-text`)).toBe(true);
	});

	it('offers a button for each link, the first as the main one', () => {
		open();

		expect(buttons().map(b => b.text)).toEqual(['GitHub Sponsors', 'Tip jar']);
		expect(buttons().map(b => b.cta)).toEqual([true, false]);
	});

	it('opens the chosen link, then closes', async () => {
		const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
		const modal = open();
		const close = vi.spyOn(modal, 'close');

		await buttons()[1].click();

		expect(openSpy).toHaveBeenCalledWith('https://example.com/tip-jar');
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('empties itself on close', () => {
		const modal = open();

		modal.close();

		expect(modal.contentEl.childNodes).toHaveLength(0);
	});
});
