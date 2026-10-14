import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ChatMessages} from '../src/classes/ui/chat-messages';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 10, 14, 30, 45));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ChatMessages', () => {
	it('starts empty', () => {
		expect(new ChatMessages().get()).toEqual([]);
	});

	it('records a user message with a timestamp', () => {
		const messages = new ChatMessages();
		messages.addUserMessage('hello');

		expect(messages.get()).toEqual([
			{role: 'user', content: 'hello', timestamp: '2026-09-10 14:30:45'},
		]);
	});

	it('records an arbitrary role', () => {
		const messages = new ChatMessages();
		messages.addMessage('text', 'assistant');

		expect(messages.get()[0].role).toBe('assistant');
	});

	it('keeps messages in order', () => {
		const messages = new ChatMessages();
		messages.addUserMessage('first');
		messages.addUserMessage('second');

		expect(messages.get().map(m => m.content)).toEqual(['first', 'second']);
	});

	describe('assistant streaming', () => {
		// The placeholder is pushed before the first token arrives, so the UI has a row to fill.
		it('begins with an empty assistant message', () => {
			const messages = new ChatMessages();
			messages.beginAssistantMessage();

			expect(messages.get()).toEqual([
				{role: 'assistant', content: '', timestamp: '2026-09-10 14:30:45'},
			]);
		});

		it('fills the placeholder as tokens arrive', () => {
			const messages = new ChatMessages();
			messages.beginAssistantMessage();

			messages.setLastAssistantContent('par');
			messages.setLastAssistantContent('partial');

			expect(messages.get()[0].content).toBe('partial');
			expect(messages.get()).toHaveLength(1);
		});

		it('keeps the timestamp from when the message began', () => {
			const messages = new ChatMessages();
			messages.beginAssistantMessage();

			vi.setSystemTime(new Date(2026, 8, 10, 14, 31, 0));
			messages.setLastAssistantContent('later');

			expect(messages.get()[0].timestamp).toBe('2026-09-10 14:30:45');
		});

		// Guards the ordering: a user message must never be overwritten by assistant tokens.
		it('does nothing when the last message is not from the assistant', () => {
			const messages = new ChatMessages();
			messages.addUserMessage('question');

			messages.setLastAssistantContent('answer');

			expect(messages.get()[0].content).toBe('question');
		});

		it('does nothing on an empty list', () => {
			const messages = new ChatMessages();

			expect(() => messages.setLastAssistantContent('answer')).not.toThrow();
			expect(messages.get()).toEqual([]);
		});

		it('updates only the most recent assistant message', () => {
			const messages = new ChatMessages();
			messages.beginAssistantMessage();
			messages.setLastAssistantContent('first answer');
			messages.addUserMessage('follow up');
			messages.beginAssistantMessage();

			messages.setLastAssistantContent('second answer');

			expect(messages.get().map(m => m.content)).toEqual([
				'first answer', 'follow up', 'second answer',
			]);
		});
	});

	describe('removeLastMessage', () => {
		// Called when a stream fails, to drop the placeholder that will never be filled.
		it('drops the most recent message', () => {
			const messages = new ChatMessages();
			messages.addUserMessage('keep');
			messages.beginAssistantMessage();

			messages.removeLastMessage();

			expect(messages.get().map(m => m.content)).toEqual(['keep']);
		});

		it('is safe on an empty list', () => {
			const messages = new ChatMessages();

			expect(() => messages.removeLastMessage()).not.toThrow();
			expect(messages.get()).toEqual([]);
		});
	});

	describe('clear', () => {
		it('empties the list', () => {
			const messages = new ChatMessages();
			messages.addUserMessage('a');

			messages.clear();

			expect(messages.get()).toEqual([]);
		});

		it('leaves a previously returned array alone', () => {
			const messages = new ChatMessages();
			messages.addUserMessage('a');
			const before = messages.get();

			messages.clear();

			// clear() reassigns rather than truncating, so an already-saved chat export is not
			// retroactively emptied.
			expect(before).toHaveLength(1);
		});
	});
});
