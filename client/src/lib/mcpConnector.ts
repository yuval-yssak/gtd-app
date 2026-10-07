import { APP_NAME } from './appName';

/** Name Claude shows for the connector. Lowercase so it doubles as a valid `claude mcp add` server name. */
export const MCP_CONNECTOR_NAME = APP_NAME.toLowerCase();

/** README for the self-hosted stdio server — only power users who want a token-based local setup need it. */
export const LOCAL_MCP_README_URL = 'https://github.com/yuval-yssak/gtd-app/blob/main/mcp-server/README.md';

/**
 * The remote MCP endpoint lives on the API origin (`api-server/src/routes/mcp.ts`), not the web
 * origin, so the URL is derived from the configured API server for whichever environment this build targets.
 */
export function mcpConnectorUrl(apiServer: string) {
    return `${apiServer.replace(/\/+$/, '')}/mcp`;
}

/**
 * One-line Claude Code command that registers the connector; Claude Code then runs the OAuth sign-in.
 * `--scope user` because the default (local) scope ties the server to the directory the command ran in,
 * so `/mcp` from any other project would not list it.
 */
export function claudeCodeAddCommand(connectorUrl: string) {
    return `claude mcp add --scope user --transport http ${MCP_CONNECTOR_NAME} ${connectorUrl}`;
}
