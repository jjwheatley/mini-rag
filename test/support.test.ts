/** @vitest-environment jsdom */
import './setup/obsidian-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import manifest from '../manifest.json';
import {fundingLinks, openFundingLink, SUPPORT_TEXT, SUPPORT_TITLE} from '../src/support';

const SPONSORS = 'https://github.com/sponsors/jjwheatley';
/** A made-up second link, so the tests can show more than one. */
const TIP_JAR = 'https://example.com/tip-jar';

afterEach(() => {
	vi.restoreAllMocks();
});

// The manifest's fundingUrl is where the links live, so every place that offers them agrees.
describe('fundingLinks', () => {
	// Mini-RAG's own: GitHub Sponsors only, for monthly and one-off support alike.
	it('finds GitHub Sponsors in Mini-RAG\'s manifest', () => {
		expect(fundingLinks(manifest.fundingUrl)).toEqual([{name: 'GitHub Sponsors', url: SPONSORS}]);
	});

	it('lists named links in the manifest\'s order', () => {
		expect(fundingLinks({'GitHub Sponsors': SPONSORS, 'Tip jar': TIP_JAR})).toEqual([
			{name: 'GitHub Sponsors', url: SPONSORS},
			{name: 'Tip jar', url: TIP_JAR},
		]);
	});

	// The manifest may give one URL instead of named ones.
	it('names a single link "Support"', () => {
		expect(fundingLinks(SPONSORS)).toEqual([{name: 'Support', url: SPONSORS}]);
	});

	it.each([undefined, null, '', 42, {}])('finds none in %j', fundingUrl => {
		expect(fundingLinks(fundingUrl)).toEqual([]);
	});

	// Only web pages: anything else in the manifest is a mistake, not somewhere to send people.
	it('skips entries that are not web links', () => {
		expect(fundingLinks({'Tip jar': TIP_JAR, Empty: '', Number: 3, Script: 'javascript:alert(1)'})).toEqual([
			{name: 'Tip jar', url: TIP_JAR},
		]);
	});
});

// The words are the author's own, so a change to them should be deliberate.
describe('wording', () => {
	it('asks in the author\'s words', () => {
		expect(SUPPORT_TITLE).toBe('Support Mini-RAG');
		expect(SUPPORT_TEXT).toBe(
			'Hi,\nMini-RAG is a one-man project. If you like what it does, please consider a monthly sponsorship '
			+ 'or a one-off tip to buy me a coffee.',
		);
	});
});

describe('openFundingLink', () => {
	it('opens the link in the browser', () => {
		const open = vi.spyOn(window, 'open').mockImplementation(() => null);

		openFundingLink({name: 'GitHub Sponsors', url: SPONSORS});

		expect(open).toHaveBeenCalledWith(SPONSORS);
	});
});
