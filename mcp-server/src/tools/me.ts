import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../apiClient.js';
import { GtdApiError } from '../apiClient.js';
import { accountSchema, defineTool, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Account-introspection tools. Without these, the model has to infer the active account by
 * reading `user` UUIDs off list responses — the operator hit this exact gap when asking which
 * account is connected. `gtd_me` answers for one account; `gtd_list_accounts` enumerates every
 * configured token in this MCP server. Both tools echo `environment` + `apiBase` so the model
 * can't silently confuse a staging account for a production account when several `mcpServers`
 * blocks (gtd-local, gtd-staging, gtd-production) are wired into the same Claude session.
 */

interface ServerMeResponse {
    userId: string;
    label: string;
    email?: string;
}

const me = defineTool({
    name: 'gtd_me',
    description:
        'Identify the account a single token is linked to. Returns the configured `account` label, ' +
        "the GTD `environment` (local / staging / production / custom) plus `apiBase` so the model can't " +
        "confuse environments when multiple GTD MCP servers are wired in, and the user's `userId`, " +
        'token `label`, and `email`. Defaults to the `default` account; pass `account` to introspect a specific one.',
    inputSchema: { account: accountSchema },
    handler: async (args, api) => {
        const response = await api.request<ServerMeResponse>('GET', '/v1/me', undefined, undefined, requestOptsFromArgs({ account: args.account }));
        return {
            account: args.account ?? 'default',
            environment: api.environment(),
            apiBase: api.apiBase(),
            userId: response.userId,
            label: response.label,
            email: response.email ?? '',
        };
    },
});

interface AccountRow {
    account: string;
    userId?: string;
    label?: string;
    email?: string;
    error?: string;
    code?: string;
}

const listAccounts = defineTool({
    name: 'gtd_list_accounts',
    description:
        'Enumerate every account configured in this MCP server (one row per `GTD_API_TOKEN` / `GTD_API_TOKEN_<LABEL>` env var). ' +
        'Each row carries `account`, `userId`, `label`, `email`. The top-level `environment` + `apiBase` echo the server-wide ' +
        'config so model output disambiguates accounts across multiple mcpServers blocks. A revoked or otherwise broken token ' +
        'returns `{ account, error, code? }` for that row instead of failing the whole call.',
    inputSchema: {},
    handler: async (_args, api) => {
        const accounts = api.listAccounts();
        const rows = await Promise.all(accounts.map((account) => fetchAccountRow(api, account)));
        return {
            environment: api.environment(),
            apiBase: api.apiBase(),
            accounts: rows,
        };
    },
});

async function fetchAccountRow(api: ApiClient, account: string): Promise<AccountRow> {
    try {
        const response = await api.request<ServerMeResponse>('GET', '/v1/me', undefined, undefined, { account });
        return { account, userId: response.userId, label: response.label, email: response.email ?? '' };
    } catch (err) {
        return buildErrorRow(account, err);
    }
}

function buildErrorRow(account: string, err: unknown): AccountRow {
    if (err instanceof GtdApiError) {
        return { account, error: err.message, ...(err.code ? { code: err.code } : {}) };
    }
    return { account, error: err instanceof Error ? err.message : String(err) };
}

export function registerMeTools(server: McpServer, api: ApiClient): void {
    registerOne(server, me, api);
    registerOne(server, listAccounts, api);
}

export const _meToolsForTesting = { me, listAccounts };
