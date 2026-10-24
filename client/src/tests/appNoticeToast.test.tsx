// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNoticeToast } from '../components/AppNoticeToast';
import { __resetAppNoticeForTests, getAppNotice, showAppNotice } from '../lib/appNotice';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    __resetAppNoticeForTests();
});

const shownText = () => screen.queryByTestId('appNoticeToast')?.textContent ?? null;

describe('AppNoticeToast', () => {
    it('shows a raised notice and hides it after its time is up', () => {
        render(<AppNoticeToast />);
        act(() => showAppNotice('Inbox clear!'));
        expect(shownText()).toContain('Inbox clear!');

        act(() => vi.advanceTimersByTime(6000));

        expect(getAppNotice()).toBeNull();
    });

    // A replacement restarts the clock: the first notice's timer must not close the second one early.
    it('a replacement notice gets its own full time on screen', () => {
        render(<AppNoticeToast />);
        act(() => showAppNotice('first'));
        act(() => vi.advanceTimersByTime(4000));
        act(() => showAppNotice('second'));
        act(() => vi.advanceTimersByTime(4000));

        expect(getAppNotice()?.message).toBe('second');
        expect(shownText()).toContain('second');
    });
});
