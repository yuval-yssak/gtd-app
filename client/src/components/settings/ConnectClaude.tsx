import { API_SERVER } from '../../constants/globals';
import { Text } from '../../designSystem';
import { APP_NAME } from '../../lib/appName';
import { claudeCodeAddCommand, LOCAL_MCP_README_URL, MCP_CONNECTOR_NAME, mcpConnectorUrl } from '../../lib/mcpConnector';
import { CopyButton } from '../CopyButton';
import styles from './ConnectClaude.module.css';

/**
 * Self-serve guide for connecting Claude to this account through the hosted MCP endpoint. The
 * endpoint runs its own OAuth sign-in, so the user never handles a token — the only input is the URL.
 */
export function ConnectClaude() {
    const connectorUrl = mcpConnectorUrl(API_SERVER);
    return (
        <div data-testid="connectClaudeSection">
            <Text variant="bodySm" className={styles.urlLabel}>
                Your connector URL:
            </Text>
            <CopyableLine value={connectorUrl} testId="mcpConnectorUrl" label="connector URL" />
            <ClaudeAppSteps />
            <ClaudeCodeSteps connectorUrl={connectorUrl} />
            <SignInSteps />
            <GoodToKnow />
        </div>
    );
}

function ClaudeAppSteps() {
    return (
        <div className={styles.block}>
            <Text variant="subtitleSm">In claude.ai or the Claude desktop app</Text>
            <ol className={styles.steps}>
                <li>
                    Open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.
                </li>
                <li>
                    Name it <strong>{APP_NAME}</strong>, paste the connector URL above, and click <strong>Add</strong>.
                </li>
                <li>
                    Click <strong>Connect</strong> on the new connector. Connectors you add on claude.ai also work in the Claude mobile app.
                </li>
            </ol>
            <Text as="p" variant="caption" tone="secondary" className={styles.note}>
                On a Claude Team or Enterprise plan, only an owner can add custom connectors (in the organization's settings); members then just click Connect.
            </Text>
        </div>
    );
}

function ClaudeCodeSteps({ connectorUrl }: { connectorUrl: string }) {
    return (
        <div className={styles.block}>
            <Text variant="subtitleSm">In Claude Code (terminal)</Text>
            <ol className={styles.steps}>
                <li>
                    Run:
                    <CopyableLine value={claudeCodeAddCommand(connectorUrl)} testId="claudeCodeAddCommand" label="command" />
                </li>
                <li>
                    In any Claude Code session, type <code>/mcp</code>, select <strong>{MCP_CONNECTOR_NAME}</strong> and choose <strong>Authenticate</strong>.
                </li>
            </ol>
        </div>
    );
}

function SignInSteps() {
    return (
        <div className={styles.block}>
            <Text variant="subtitleSm">Then sign in</Text>
            <ol className={styles.steps}>
                <li>A browser window opens. If it asks you to sign in, use the Google or GitHub account you use here.</li>
                <li>
                    The <strong>Authorize access</strong> page lists the {APP_NAME} accounts signed in on this browser. Click <strong>Allow</strong> for the one
                    Claude should use. If it isn't listed, choose <strong>Use a different account</strong> on the same page and sign in with it.
                </li>
                <li>
                    Back in Claude, ask something like <em>“What's in my {APP_NAME} inbox?”</em> to check the connection.
                </li>
            </ol>
        </div>
    );
}

function GoodToKnow() {
    return (
        <div className={styles.block}>
            <Text variant="subtitleSm">Good to know</Text>
            <ul className={styles.steps}>
                <li>Claude stays signed in. You'll only be asked to sign in again after a month without use.</li>
                <li>
                    Each connector reaches one account. For a second account, add a second connector (e.g. {APP_NAME} Work) and click <strong>Allow</strong> for
                    that account on the Authorize page.
                </li>
                <li>To disconnect, remove the connector in Claude.</li>
                <li>
                    Prefer running the server on your own machine with a personal API token? See the{' '}
                    <a href={LOCAL_MCP_README_URL} target="_blank" rel="noopener noreferrer" data-testid="localMcpReadmeLink">
                        local MCP server guide
                    </a>
                    .
                </li>
            </ul>
        </div>
    );
}

/** A monospace value the user pastes elsewhere, with a copy button beside it. */
function CopyableLine({ value, testId, label }: { value: string; testId: string; label: string }) {
    return (
        <div className={styles.copyBox}>
            <span className={styles.copyText} data-testid={testId}>
                {value}
            </span>
            <CopyButton value={value} label={label} testId={`${testId}CopyButton`} />
        </div>
    );
}
