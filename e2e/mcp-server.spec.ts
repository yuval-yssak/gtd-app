import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';
// Resolved against this file's directory at run time so the spec works regardless of cwd.
const MCP_DIST = path.resolve(__dirname, '../tools/mcp-gtd/dist/index.js');
// Wide enough to absorb cold-start of node + @modelcontextprotocol/sdk + the dev API server
// on slow CI runners. The wider call timeout still surfaces a hung MCP within the spec's 30s
// envelope and the cost of waiting longer on a real hang is just a slower failure.
const MCP_CALL_TIMEOUT_MS = 20_000;

/**
 * MCP framing per `tools/mcp-gtd/node_modules/@modelcontextprotocol/sdk/.../shared/stdio.js`:
 * newline-delimited JSON. Each message is `JSON.stringify(...)+'\n'`.
 *
 * We hand-roll the JSON-RPC client rather than pull in `@modelcontextprotocol/sdk` as an e2e
 * dependency — the four tools we need to drive are simple `tools/call` invocations and the
 * surface area we actually want to test is "does the bin work end-to-end against a real
 * /v1 server". Adding the SDK would bloat the e2e package without adding coverage.
 */
class McpStdioClient {
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, { resolve: (msg: unknown) => void; reject: (err: Error) => void }>();
    private readonly stderrChunks: string[] = [];
    private buffer = '';
    private nextId = 1;
    // Captured asynchronously so the first send() can surface "spawn ENOENT" / "exit code 1"
    // immediately, rather than waiting for the per-call timeout to expire.
    private fatalError: Error | null = null;

    constructor(token: string) {
        this.proc = spawn('node', [MCP_DIST], {
            env: {
                ...process.env,
                GTD_API_BASE_URL: `${API_URL}/v1`,
                GTD_API_TOKEN: token,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (chunk: string) => this.stderrChunks.push(chunk));
        this.proc.on('error', (err) => this.recordFatal(new Error(`mcp-gtd spawn failed: ${err.message}. stderr: ${this.stderrChunks.join('')}`)));
        this.proc.on('exit', (code, signal) => {
            // SIGTERM is the close() path — expected, not an error.
            if (signal === 'SIGTERM') return;
            if (code !== 0 && code !== null) {
                this.recordFatal(new Error(`mcp-gtd exited with code ${code}. stderr: ${this.stderrChunks.join('')}`));
            }
        });
    }

    private recordFatal(err: Error): void {
        this.fatalError = err;
        for (const { reject } of this.pending.values()) {
            reject(err);
        }
        this.pending.clear();
    }

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let newline: number = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).replace(/\r$/, '');
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim() !== '') {
                this.dispatchLine(line);
            }
            newline = this.buffer.indexOf('\n');
        }
    }

    private dispatchLine(line: string): void {
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            this.stderrChunks.push(`[malformed json from MCP] ${line}`);
            return;
        }
        if (typeof msg === 'object' && msg !== null && 'id' in msg) {
            const id = (msg as { id: unknown }).id;
            if (typeof id === 'number') {
                const handler = this.pending.get(id);
                if (handler) {
                    this.pending.delete(id);
                    handler.resolve(msg);
                }
            }
        }
    }

    async send<T>(method: string, params: unknown): Promise<T> {
        if (this.fatalError) {
            throw this.fatalError;
        }
        const id = this.nextId++;
        const message = { jsonrpc: '2.0' as const, id, method, params };
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (msg: unknown) => void, reject });
            this.proc.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
                if (err) {
                    this.pending.delete(id);
                    reject(err);
                }
            });
            // Per-call timeout — keeps a hung MCP server from holding up the suite.
            setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`MCP request '${method}' timed out after ${MCP_CALL_TIMEOUT_MS}ms. stderr: ${this.stderrChunks.join('')}`));
                }
            }, MCP_CALL_TIMEOUT_MS);
        });
    }

    close(): void {
        this.proc.stdin.end();
        this.proc.kill('SIGTERM');
    }
}

interface JsonRpcResult {
    result?: { content?: Array<{ type: 'text'; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
}

/** Initializes the MCP session per the protocol's required handshake before tools can be called. */
async function initializeMcp(client: McpStdioClient): Promise<void> {
    const init = await client.send<JsonRpcResult>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gtd-e2e', version: '0.0.0' },
    });
    expect(init.error).toBeUndefined();
}

async function callTool(client: McpStdioClient, name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await client.send<JsonRpcResult>('tools/call', { name, arguments: args });
    expect(res.error, `tools/call ${name} returned error: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(res.result?.isError, `tool ${name} returned isError=true with content ${JSON.stringify(res.result?.content)}`).not.toBe(true);
    const text = res.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
        throw new Error(`tool ${name} returned no text content; result=${JSON.stringify(res.result)}`);
    }
    return JSON.parse(text);
}

test.describe('MCP server (mcp-gtd)', () => {
    test('drives the four tools end-to-end against a real /v1 server', async ({ browser }) => {
        const email = `mcp-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            // Mint a real bearer token via the page's session.
            const mintRes = await page.context().request.post(`${API_URL}/account/tokens`, { data: { label: 'mcp-e2e' } });
            const { plaintext } = (await mintRes.json()) as { plaintext: string };

            const mcp = new McpStdioClient(plaintext);
            try {
                await initializeMcp(mcp);

                // 1. create_inbox_item — returns the created item.
                const created = (await callTool(mcp, 'create_inbox_item', { title: 'From MCP', externalId: 'mcp-1' })) as {
                    _id: string;
                    title: string;
                    status: string;
                };
                expect(created.title).toBe('From MCP');
                expect(created.status).toBe('inbox');

                // 2. search_items — should return the item we just created.
                const search = (await callTool(mcp, 'search_items', { status: 'inbox', limit: 50 })) as {
                    items: Array<{ _id: string; title: string }>;
                };
                expect(search.items.some((i) => i._id === created._id)).toBe(true);

                // 3. get_item — fetches the item by id.
                const got = (await callTool(mcp, 'get_item', { id: created._id })) as { _id: string; title: string };
                expect(got._id).toBe(created._id);
                expect(got.title).toBe('From MCP');

                // 4. complete_item — transitions to done.
                const completed = (await callTool(mcp, 'complete_item', { id: created._id })) as { _id: string; status: string };
                expect(completed.status).toBe('done');
            } finally {
                mcp.close();
            }
        });
    });
});
