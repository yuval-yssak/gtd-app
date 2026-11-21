/** The session link is rendered as a clickable anchor in Done, so only an https claude.ai URL is accepted. */
export function isClaudeSessionUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai'));
    } catch {
        return false;
    }
}
