// Declare the env vars the MCP server reads so dot-access (`process.env.GTD_API_TOKEN`) is
// allowed under `noPropertyAccessFromIndexSignature`. Mirrors api-server/src/env.d.ts.
declare namespace NodeJS {
    interface ProcessEnv {
        GTD_API_BASE?: string;
        GTD_API_TOKEN?: string;
    }
}
