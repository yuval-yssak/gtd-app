/** Server stdout goes to Cloud Logging, and the privacy policy describes those logs as holding
 * route, timing, status, identifiers — never the text of a user's items, calendar events or an
 * email address. This scans every `console.*` call in the request-serving source (all of src/
 * except the operator CLIs under scripts/, which print to a terminal, and the tests) so a new log
 * line that interpolates a title, notes, an attendee or a recipient fails here.
 *
 * It only sees string interpolation and object literals. An error object dumped whole
 * (`console.error('…', err)`) is covered by lib/googleErrorRedactor.ts and its runtime test, not
 * by this scan. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const SKIPPED_DIRS = new Set(['scripts', 'tests', 'tests-sync-audit']);

// A console call up to its closing `);` — spans multi-line templates; no length cap, so a call
// that never matches is a regex bug the count assertion below surfaces rather than a silent skip.
const CONSOLE_CALL = /console\.(?:log|warn|error|info|debug)\(([\s\S]*?)\);/g;
const CONSOLE_OPEN = /console\.(?:log|warn|error|info|debug)\(/g;

// `calendarId` is the account's email address for a primary calendar. `to` only counts as a
// property or a bare variable — `to=${…}` is how id pairs are written (`from=… to=…`).
const CONTENT_FIELDS = 'title|summary|notes|description|location|displayName|attendees|email|accountEmail|calendarId';
const LEAKS = [
    // `title=${…}` — a content field assigned into the line
    new RegExp(`\\b(?:${CONTENT_FIELDS})=\\$\\{`),
    // `${item.title}`, `${event.summary ?? ''}`, `${args.to}` — a content property inside an interpolation
    new RegExp(`\\$\\{[^}]*\\.(?:${CONTENT_FIELDS}|to)\\b`),
    // bare content variables
    /\$\{(?:title|summary|notes|description|email|to|calendarId)\}/,
    // whole entities serialised into the line
    /\bJSON\.stringify\((?:snapshot|event|item|routine|rawEvent|existing|person)\b/,
    // an object literal argument carrying a content key: console.log('x', { title })
    /[{,]\s*(?:title|summary|notes|description|location|email)\s*[,:}]/,
];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(entry) ? [] : sourceFiles(path);
        return path.endsWith('.ts') ? [path] : [];
    });
}

function consoleCalls(source: string) {
    return [...source.matchAll(CONSOLE_CALL)].map((match) => match[1] ?? '');
}

function leakingCalls(source: string) {
    return consoleCalls(source).filter((call) => LEAKS.some((leak) => leak.test(call)));
}

describe('server log redaction', () => {
    const files = sourceFiles(SRC_DIR).map((file) => ({ file: relative(SRC_DIR, file), source: readFileSync(file, 'utf8') }));

    it('scans the request-serving source, and every console call it contains is captured whole', () => {
        const opened = files.reduce((count, { source }) => count + (source.match(CONSOLE_OPEN)?.length ?? 0), 0);
        const captured = files.reduce((count, { source }) => count + consoleCalls(source).length, 0);
        expect(opened).toBeGreaterThan(100);
        expect(captured).toBe(opened);
    });

    it('no console call interpolates an item title, notes, a calendar id or an email address', () => {
        const offenders = files.flatMap(({ file, source }) => leakingCalls(source).map((call) => `${file}: ${call.trim().slice(0, 120)}`));
        expect(offenders).toEqual([]);
    });
});

// Fixtures are template literals with `\${` escaped, so they read like the source they imitate.
describe('leakingCalls (the scan itself)', () => {
    it('flags a multi-line template that interpolates a title, and a stringified entity', () => {
        const leaky = `console.log(\n    \`[x] trashing | itemId=\${item._id} title="\${item.title}"\`,\n);\nconsole.error(\`payload \${JSON.stringify(snapshot)}\`);`;
        expect(leakingCalls(leaky)).toHaveLength(2);
    });

    it('flags a fallback interpolation, an object-literal key, a bare recipient and a calendar id', () => {
        expect(leakingCalls(`console.log(\`title=\${x.title ?? 'n/a'}\`);`)).toHaveLength(1);
        expect(leakingCalls(`console.warn('sent', { title });`)).toHaveLength(1);
        expect(leakingCalls(`console.log(\`mail \${to}\`);`)).toHaveLength(1);
        expect(leakingCalls(`console.log(\`sync | configId=\${config._id} calendarId=\${config.calendarId}\`);`)).toHaveLength(1);
    });

    it('does not flag id pairs or identifier-only lines', () => {
        expect(leakingCalls(`console.log(\`re-anchoring | from=\${a.rawId} to=\${b.rawId}\`);`)).toEqual([]);
        expect(leakingCalls(`console.log(\`[gcal] updating | eventId=\${eventId} itemId=\${snapshot._id} status=\${snapshot.status}\`);`)).toEqual([]);
        expect(leakingCalls(`console.log(\`stamped \${dayjs().toISOString()}\`);`)).toEqual([]);
    });
});
