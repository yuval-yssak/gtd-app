import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, type z, z as zod } from 'zod';
import { type ApiClient, GtdApiError, type RequestOptions } from '../apiClient.js';

/**
 * Shared id schema — non-empty AFTER trim, so callers can't 404 the API with `id: '   '`.
 * Mirrors `parseReassignBody`'s entityId check in api-server/src/routes/v1/reassign.ts. The
 * direct entity routes (GET /v1/items/:id etc.) don't trim — using this everywhere is the
 * MCP layer's contribution to clearer error signals back to the model.
 */
export const idSchema = zod.string().refine((s) => s.trim().length > 0, { message: 'id must not be whitespace-only' });

/**
 * Optional `account` selector that every tool accepts. Defaults to `'default'` server-side
 * (in `apiClient.request`); a non-default value picks a non-default `GTD_API_TOKEN_<LABEL>`.
 */
export const accountSchema = zod
    .string()
    .min(1)
    .optional()
    .describe('Account label whose token signs this call. Defaults to "default" — set additional accounts via GTD_API_TOKEN_<LABEL> env vars.');

/**
 * Builds the `RequestOptions` payload for `apiClient.request`. Centralised so adding a new
 * option (e.g. recipientAccount) requires changing one helper, not every tool. Returns
 * `undefined` when no option is set so the apiClient sees a single argument shape.
 */
export function requestOptsFromArgs(args: { account?: string | undefined; recipientAccount?: string | undefined }): RequestOptions | undefined {
    if (!args.account && !args.recipientAccount) {
        return undefined;
    }
    return {
        ...(args.account ? { account: args.account } : {}),
        ...(args.recipientAccount ? { recipientAccount: args.recipientAccount } : {}),
    };
}

/**
 * Shape of a tool definition. The MCP SDK's `registerTool` takes a `ZodRawShape` for
 * `inputSchema` (record of Zod schemas, one per top-level field). We type the handler as
 * receiving the inferred object output of that shape.
 */
export interface ToolDef<Shape extends ZodRawShape> {
    name: string;
    description: string;
    inputSchema: Shape;
    handler: (args: ParsedArgs<Shape>, api: ApiClient) => Promise<unknown>;
}

// Mirror Zod's `z.object(...)` inference: keys whose schema produces `| undefined` become
// optional keys (`?:`) rather than required keys with `undefined` values. Without this, tests
// would have to spell out every optional field as `field: undefined`.
type OptionalKeys<Shape extends ZodRawShape> = {
    [K in keyof Shape]: undefined extends z.infer<Shape[K]> ? K : never;
}[keyof Shape];
type RequiredKeys<Shape extends ZodRawShape> = Exclude<keyof Shape, OptionalKeys<Shape>>;

export type ParsedArgs<Shape extends ZodRawShape> = {
    [K in RequiredKeys<Shape>]: z.infer<Shape[K]>;
} & {
    [K in OptionalKeys<Shape>]?: z.infer<Shape[K]>;
};

/** Helper to define a tool with full type inference at the call site. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
    return def;
}

/**
 * Closure-style tool registrar. Each per-tool group exports a `register<Group>(server, api)`
 * function that calls this once per tool, keeping per-tool generics bound. We can't store
 * heterogeneous ToolDefs in an array — Zod raw shapes are invariant, so widening collapses
 * the inferred handler argument types.
 */

/**
 * Registers a single tool against an `McpServer`. The per-tool generic stays intact —
 * registration happens one tool at a time so the handler's argument inference flows through
 * to the SDK's callback. (Storing tools in a heterogeneous array would require widening their
 * generics, which TypeScript flags as a contravariance error on `handler`.)
 */
export function registerOne<Shape extends ZodRawShape>(server: McpServer, tool: ToolDef<Shape>, api: ApiClient): void {
    // The SDK's BaseToolCallback type uses an indexed signature `[k: string]: unknown` because
    // it doesn't see the inputSchema's specific shape. We cast our typed handler accordingly —
    // the runtime contract is identical: the SDK validates args against inputSchema before
    // invoking, so by the time `args` lands here it conforms to ParsedArgs<Shape>.
    server.registerTool(
        tool.name,
        {
            description: tool.description,
            inputSchema: tool.inputSchema,
        },
        (async (args: unknown) => {
            try {
                const result = await tool.handler(args as ParsedArgs<Shape>, api);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                return formatError(err);
            }
        }) as never,
    );
}

/**
 * Surfaces API errors verbatim — including `extra: { status, field }` for status×field matrix
 * violations — so the model can self-correct (e.g. retry a PATCH without `ignoreBefore` when
 * the target status is `calendar`). isError:true tells the MCP client this is a tool failure.
 */
export function formatError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
    if (err instanceof GtdApiError) {
        const payload = {
            error: err.message,
            status: err.status,
            ...(err.code ? { code: err.code } : {}),
            ...(err.body && typeof err.body === 'object' ? { body: err.body } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}
