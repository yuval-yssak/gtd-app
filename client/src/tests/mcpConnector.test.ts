import { describe, expect, it } from 'vitest';
import { claudeCodeAddCommand, MCP_CONNECTOR_NAME, mcpConnectorUrl } from '../lib/mcpConnector';

describe('mcpConnectorUrl', () => {
    it('appends /mcp to the API origin', () => {
        expect(mcpConnectorUrl('https://api.getting-things-done.app')).toBe('https://api.getting-things-done.app/mcp');
    });

    it('does not double the slash when the API origin has a trailing slash', () => {
        expect(mcpConnectorUrl('http://localhost:4000/')).toBe('http://localhost:4000/mcp');
        expect(mcpConnectorUrl('http://localhost:4000//')).toBe('http://localhost:4000/mcp');
    });
});

describe('claudeCodeAddCommand', () => {
    it('registers an HTTP-transport server under the connector name', () => {
        expect(claudeCodeAddCommand('https://api.getting-things-done.app/mcp')).toBe(
            'claude mcp add --scope user --transport http done https://api.getting-things-done.app/mcp',
        );
    });

    it('uses a lowercase server name, which claude mcp add accepts', () => {
        expect(MCP_CONNECTOR_NAME).toMatch(/^[a-z0-9-]+$/);
    });
});
