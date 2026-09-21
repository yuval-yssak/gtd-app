import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSseConnections, getOpenSseUserIds, openSseConnections, reopenSseConnections } from '../db/sseClient';

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
            this.readyState = StubEventSource.CLOSED;
        }
        // The real EventSource exposes these as statics; dropDeadConnections reads EventSource.CLOSED.
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
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

describe('dead-channel eviction', () => {
    it('replaces a channel whose socket closed underneath us (iOS freezing a backgrounded PWA)', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);
        const [frozen] = created;
        if (!frozen) throw new Error('expected one channel');

        // Simulate the OS tearing the connection down without the app closing it.
        frozen.readyState = 2;
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        // Pre-fix this was a no-op: the Map still had the entry, so `has(userId)` reported it live
        // and the dead socket was never replaced.
        expect(created).toHaveLength(2);
        expect(getOpenSseUserIds()).toEqual(['user-a']);
    });

    it('evicts only the dead channel on a multi-account device', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);
        const [deadA, liveB] = created;
        if (!deadA || !liveB) throw new Error('expected two channels');

        deadA.readyState = 2;
        openSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);

        // Only user-a is replaced; user-b's healthy socket is left untouched.
        expect(created).toHaveLength(3);
        expect(liveB.closed).toBe(false);
        expect(getOpenSseUserIds().sort()).toEqual(['user-a', 'user-b']);
    });

    it('leaves a merely-reconnecting channel alone (CONNECTING is recoverable, not dead)', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);
        const [reconnecting] = created;
        if (!reconnecting) throw new Error('expected one channel');

        reconnecting.readyState = 0;
        openSseConnections(onUpdate, 'dev-1', ['user-a']);

        expect(created).toHaveLength(1);
    });
});

describe('reopenSseConnections', () => {
    it('discards and recreates every channel regardless of a healthy-looking readyState', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);
        const [staleA, staleB] = created;

        // Both still claim OPEN — a resumed web view can report this for a dropped connection.
        reopenSseConnections(onUpdate, 'dev-1', ['user-a', 'user-b']);

        expect(staleA?.closed).toBe(true);
        expect(staleB?.closed).toBe(true);
        expect(created).toHaveLength(4);
        expect(getOpenSseUserIds().sort()).toEqual(['user-a', 'user-b']);
    });

    it('closes everything and opens nothing when no accounts are logged in', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);
        const [existing] = created;

        // Reachable on resume: loggedInUserIdsRef starts empty and a resume can beat the effect
        // that mirrors the account list into it.
        reopenSseConnections(onUpdate, 'dev-1', []);

        expect(existing?.closed).toBe(true);
        expect(created).toHaveLength(1);
        expect(getOpenSseUserIds()).toEqual([]);
    });

    it('routes messages from the fresh channel to onUpdate', () => {
        const onUpdate = vi.fn();
        openSseConnections(onUpdate, 'dev-1', ['user-a']);
        reopenSseConnections(onUpdate, 'dev-1', ['user-a']);

        const fresh = created[1];
        fresh?.onmessage?.({ data: JSON.stringify({ type: 'update' }) } as MessageEvent);

        expect(onUpdate).toHaveBeenCalledWith('user-a');
    });
});
