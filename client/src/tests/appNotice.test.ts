import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAppNoticeForTests, dismissAppNotice, getAppNotice, showAppNotice, subscribeToAppNotice } from '../lib/appNotice';

afterEach(__resetAppNoticeForTests);

describe('app notice store', () => {
    it('holds the latest notice and tells subscribers', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToAppNotice(listener);

        showAppNotice('Inbox clear!');

        expect(getAppNotice()?.message).toBe('Inbox clear!');
        expect(listener).toHaveBeenCalledOnce();
        unsubscribe();
    });

    it('a newer notice replaces the shown one', () => {
        showAppNotice('first');
        showAppNotice('second');

        expect(getAppNotice()?.message).toBe('second');
    });

    // The toast that showed the first notice may close after a second one replaced it: that late
    // close must not wipe the newer notice.
    it('dismissing an outdated notice leaves the current one showing', () => {
        showAppNotice('first');
        const first = getAppNotice();
        showAppNotice('second');
        if (!first) throw new Error('expected a notice');

        dismissAppNotice(first.id);

        expect(getAppNotice()?.message).toBe('second');
    });

    it('dismissing the current notice clears it', () => {
        showAppNotice('only');
        const shown = getAppNotice();
        if (!shown) throw new Error('expected a notice');

        dismissAppNotice(shown.id);

        expect(getAppNotice()).toBeNull();
    });
});
