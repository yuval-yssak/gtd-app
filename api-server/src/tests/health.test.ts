/** GET /health (routes/health.ts): 200 while the Mongo ping succeeds, 503 when the probe fails, and
 * — the endpoint's real claim — the ping gives up within its bound when a CONNECTED server stops
 * answering. The ok path runs the real `pingDatabase` against this file's test database; the 503
 * path injects a rejecting probe; the timeout path drives a second client through a TCP proxy that
 * forwards until told to stall, which mimics a pool whose sockets are open but dead. */
import { type AddressInfo, connect as connectTcp, createServer, type Socket } from 'node:net';
import dayjs from 'dayjs';
import { MongoClient, MongoOperationTimeoutError } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';
import { createHealthRoutes, createPingProbe, pingDatabase } from '../routes/health.js';

const STALL_PROBE_TIMEOUT_MS = 500;

/** Host + port of the test mongod, taken from the same URL the suite connects with. */
function testMongoAddress() {
    const url = new URL(process.env.MONGO_DB_URL ?? 'mongodb://127.0.0.1:27017');
    return { host: url.hostname, port: Number(url.port || 27017) };
}

function listeningPort(server: ReturnType<typeof createServer>) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    return (address satisfies AddressInfo).port;
}

/** TCP proxy in front of mongod. `stall()` keeps every socket open but stops relaying bytes both ways. */
async function startStallableProxy() {
    const { host, port } = testMongoAddress();
    const sockets: Socket[] = [];
    const relay = { stalled: false };
    const server = createServer((client) => {
        const upstream = connectTcp(port, host);
        sockets.push(client, upstream);
        client.on('data', (chunk) => !relay.stalled && upstream.write(chunk));
        upstream.on('data', (chunk) => !relay.stalled && client.write(chunk));
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.on('error', () => {});
        upstream.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: listeningPort(server),
        stall: () => {
            relay.stalled = true;
        },
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

describe('GET /health', () => {
    it('returns 200 { status: "ok" } when the database answers the ping', async () => {
        const res = await createHealthRoutes(pingDatabase).request('/');
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ status: 'ok' });
    });

    it('returns 503 { status: "unavailable" } when the probe rejects', async () => {
        const deadPool = async () => {
            throw new Error('PoolClearedOnNetworkError');
        };
        const res = await createHealthRoutes(deadPool).request('/');
        expect(res.status).toBe(503);
        await expect(res.json()).resolves.toEqual({ status: 'unavailable' });
    });
});

describe('createPingProbe', () => {
    // The proxy fronts one plain TCP host; an SRV / multi-host MONGO_DB_URL (e.g. a leaked Atlas
    // export) has nothing it can stand in front of.
    const isSingleHostMongo = new URL(process.env.MONGO_DB_URL ?? 'mongodb://127.0.0.1:27017').protocol === 'mongodb:';

    it.skipIf(!isSingleHostMongo)('gives up within its bound when a connected server stops answering', async () => {
        const proxy = await startStallableProxy();
        const client = new MongoClient(`mongodb://127.0.0.1:${proxy.port}`, { directConnection: true });
        try {
            await client.connect();
            // Warm a pooled socket so the probe reuses a connection the driver believes is healthy.
            await client.db('admin').command({ ping: 1 });
            proxy.stall();
            const probe = createPingProbe(() => client.db('admin'), STALL_PROBE_TIMEOUT_MS);
            const started = dayjs();
            await expect(probe()).rejects.toBeInstanceOf(MongoOperationTimeoutError);
            expect(dayjs().diff(started)).toBeLessThan(STALL_PROBE_TIMEOUT_MS * 4);
        } finally {
            // Proxy first: `client.close()` waits on the stalled socket otherwise (measured: >3 s).
            await proxy.close();
            await client.close(true);
        }
    });
});
