import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSseConnections, getOpenSseUserIds, openSseConnections } from '../db/sseClient';

// Mock the API_SERVER constant so URLs are predictable in assertions.
vi.mock('../constants/globals', () => ({ API_SERVER: 'http://test.local' }));

// EventSource isn't part of the JSDOM globals; tests use a controllable mock implementation
// that lets us drive `onmessage` / `onerror` directly. Each constructor invocation registers
// itself in `created` so assertions can inspect the URL it was given.
interface FakeEventSource {
    url: string;
    closed: boolean;
    close: () => void;
    onmessage: ((event: MessageEvent) => void) | null;
    onopen: (() => void) | null;
    onerror: ((event: unknown) => void) | null;
    readyState: number;
}

let created: FakeEventSource[] = [];

beforeEach(() => {
    created = [];
    class StubEventSource implements FakeEventSource {
        url: string;
        closed = false;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onopen: (() => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        readyState = 1;
        constructor(url: string, _init?: { withCredentials?: boolean }) {
            this.url = url;
            created.push(this);
        }
        close(): void {
            this.closed = true;
        }
    }
    (globalThis as unknown as { EventSource: typeof StubEventSource }).EventSource = StubEventSource;
});

afterEach(() => {
    closeSseConnections();
});

describe('openSseConnections', () => {
    it('opens one EventSource per userId, each with the per-user query param', () => {
        openSseConnections(() => {}, 'dev-1', ['user-a', 'user-b']);

        expect(created).toHaveLength(2);
        expect(created[0]?.url).toBe('http://test.local/sync/events?userId=user-a');
        expect(created[1]?.url).toBe('http://test.local/sync/events?userId=user-b');
        expect(getOpenSseUserIds().sort()).toEqual(['user-a', 'user-b']);
    });

    it('is idempotent — calling with the same userIds does not reopen channels', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);
        const firstSource = created[0];
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        // No new EventSource was created on the second call.
        expect(created).toHaveLength(1);
        expect(firstSource?.closed).toBe(false);
    });

    it('closes channels for users that are no longer in the list on a subsequent call', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);
        const userBSource = created[1];

        // Drop user-b — the corresponding channel must close.
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        expect(userBSource?.closed).toBe(true);
        expect(getOpenSseUserIds()).toEqual(['user-a']);
    });

    it('passes the userId of the originating channel to onUpdate', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);

        const userBSource = created[1];
        userBSource?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'update' }) }));

        expect(onUpdate).toHaveBeenCalledExactlyOnceWith('user-b');
    });

    it('ignores echoed events (sourceDeviceId matches localDeviceId)', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        created[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'update', sourceDeviceId: 'dev-1' }) }));
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('ignores malformed event payloads without throwing', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        // Not JSON — JSON.parse throws inside handleMessage; the handler must catch and continue.
        expect(() => created[0]?.onmessage?.(new MessageEvent('message', { data: 'not-json' }))).not.toThrow();
        expect(onUpdate).not.toHaveBeenCalled();
    });
});

describe('closeSseConnections', () => {
    it('closes every channel and clears the registry', () => {
        openSseConnections(() => {}, 'dev-1', ['user-a', 'user-b']);
        closeSseConnections();

        expect(created.every((s) => s.closed)).toBe(true);
        expect(getOpenSseUserIds()).toEqual([]);
    });
});
