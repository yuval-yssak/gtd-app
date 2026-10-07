import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { API_SERVER } from '../../constants/globals';
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
        <Box data-testid="connectClaudeSection">
            <Typography variant="body2" sx={{ mb: 0.5 }}>
                Your connector URL:
            </Typography>
            <CopyableLine value={connectorUrl} testId="mcpConnectorUrl" label="connector URL" />
            <ClaudeAppSteps />
            <ClaudeCodeSteps connectorUrl={connectorUrl} />
            <SignInSteps />
            <GoodToKnow />
        </Box>
    );
}

function ClaudeAppSteps() {
    return (
        <Box className={styles.block}>
            <Typography variant="subtitle2">In claude.ai or the Claude desktop app</Typography>
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
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 0.5 }}>
                On a Claude Team or Enterprise plan, only an owner can add custom connectors (in the organization's settings); members then just click Connect.
            </Typography>
        </Box>
    );
}

function ClaudeCodeSteps({ connectorUrl }: { connectorUrl: string }) {
    return (
        <Box className={styles.block}>
            <Typography variant="subtitle2">In Claude Code (terminal)</Typography>
            <ol className={styles.steps}>
                <li>
                    Run:
                    <CopyableLine value={claudeCodeAddCommand(connectorUrl)} testId="claudeCodeAddCommand" label="command" />
                </li>
                <li>
                    In any Claude Code session, type <code>/mcp</code>, select <strong>{MCP_CONNECTOR_NAME}</strong> and choose <strong>Authenticate</strong>.
                </li>
            </ol>
        </Box>
    );
}

function SignInSteps() {
    return (
        <Box className={styles.block}>
            <Typography variant="subtitle2">Then sign in</Typography>
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
        </Box>
    );
}

function GoodToKnow() {
    return (
        <Box className={styles.block}>
            <Typography variant="subtitle2">Good to know</Typography>
            <ul className={styles.steps}>
                <li>Claude stays signed in. You'll only be asked to sign in again after a month without use.</li>
                <li>
                    Each connector reaches one account. For a second account, add a second connector (e.g. {APP_NAME} Work) and click <strong>Allow</strong> for
                    that account on the Authorize page.
                </li>
                <li>To disconnect, remove the connector in Claude.</li>
                <li>
                    Prefer running the server on your own machine with a personal API token? See the{' '}
                    <Link href={LOCAL_MCP_README_URL} target="_blank" rel="noopener noreferrer" data-testid="localMcpReadmeLink">
                        local MCP server guide
                    </Link>
                    .
                </li>
            </ul>
        </Box>
    );
}

/** A monospace value the user pastes elsewhere, with a copy button beside it. */
function CopyableLine({ value, testId, label }: { value: string; testId: string; label: string }) {
    return (
        <Box className={styles.copyBox}>
            <Box component="span" className={styles.copyText} data-testid={testId}>
                {value}
            </Box>
            <CopyButton value={value} label={label} testId={`${testId}CopyButton`} />
        </Box>
    );
}
