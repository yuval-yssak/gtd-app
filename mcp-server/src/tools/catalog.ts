import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '../apiClient.js';
import { registerBatchTools } from './batch.js';
import { registerItemTools } from './items.js';
import { registerMeTools } from './me.js';
import { registerPeopleTools } from './people.js';
import { registerReassignTools } from './reassign.js';
import { registerRoutineTools } from './routines.js';
import { registerWorkContextTools } from './workContexts.js';

/** Registers every tool group — the one list both the stdio binary and the hosted `/mcp` route serve. */
export function registerAllTools(server: McpServer, api: ApiClient): void {
    registerItemTools(server, api);
    registerRoutineTools(server, api);
    registerPeopleTools(server, api);
    registerWorkContextTools(server, api);
    registerReassignTools(server, api);
    registerBatchTools(server, api);
    registerMeTools(server, api);
}
