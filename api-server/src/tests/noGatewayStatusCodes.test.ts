/**
 * The API sits behind a Cloudflare Worker proxy, and Cloudflare replaces any ORIGIN 502 or 504 with
 * its own branded HTML error page — no CORS headers, no JSON. A browser then reports a network
 * failure ("Failed to fetch") instead of our error, and a public-API caller gets HTML instead of the
 * documented `code`. (Seen on production 2026-10-04: a 502 from the calendar list never reached the
 * client.) So the server must never answer with 502 or 504; this scan fails if one comes back.
 *
 * It matches the bare literal on every code line (comments stripped) rather than a call shape, so it
 * also catches Biome-wrapped calls where the status sits alone on its own line, `c.status(502)`,
 * `new HTTPException(504, …)` and constants. A line that genuinely needs the number (say, an
 * upstream-retry list) can opt out with a trailing `// gateway-status-ok` comment.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const OPT_OUT_MARKER = 'gateway-status-ok';
const GATEWAY_STATUS = /(?<![\w.])50[24](?![\w.])/;

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            return name === 'tests' || name === 'tests-sync-audit' ? [] : sourceFiles(full);
        }
        return full.endsWith('.ts') ? [full] : [];
    });
}

/** The code part of a line: block-comment lines dropped, `//` tails stripped. Opted-out lines read as empty. */
function codeOf(line: string): string {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/*') || line.includes(OPT_OUT_MARKER)) {
        return '';
    }
    return line.replace(/\/\/.*$/, '');
}

function hasGatewayStatus(line: string): boolean {
    return GATEWAY_STATUS.test(codeOf(line));
}

describe('no 502/504 responses from the API', () => {
    it('never returns a gateway status that the Cloudflare proxy would replace with an HTML page', () => {
        const offenders = sourceFiles(SRC_DIR).flatMap((file) =>
            readFileSync(file, 'utf8')
                .split('\n')
                .flatMap((line, index) => (hasGatewayStatus(line) ? [`${relative(SRC_DIR, file)}:${index + 1}: ${line.trim()}`] : [])),
        );
        expect(offenders, 'use 503 (upstream unavailable / retryable), 500 (unexpected) or a 4xx instead').toEqual([]);
    });

    // Self-test: a guard that silently stops matching is worse than none.
    it.each([
        "    return c.json({ error: 'x' }, 502);",
        '        502,',
        '    c.status(504);',
        "    throw new HTTPException(502, { message: 'x' });",
        '    statusCode: 504,',
        'const UPSTREAM_DOWN = 502;',
    ])('flags %s', (line) => {
        expect(hasGatewayStatus(line)).toBe(true);
    });

    it.each([
        '// a comment mentioning 502 is fine',
        ' * so is a JSDoc line about 504',
        "    return c.json({ error: 'x' }, 503); // was 502",
        '    const ids = [5020, 1502, 504.5];',
        '    retryOn: [502, 503, 504], // gateway-status-ok',
    ])('does not flag %s', (line) => {
        expect(hasGatewayStatus(line)).toBe(false);
    });
});
