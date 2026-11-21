import { type FormEvent, useState } from 'react';
import { Button, Text, TextField } from '../../designSystem';
import { CopyButton } from '../CopyButton';
import styles from './ClaudeRoutineSection.module.css';
import {
    CLAUDE_ROUTINES_URL,
    type DraftProblem,
    describeStoredConnection,
    SUGGESTED_CLAUDE_ROUTINE_PROMPT,
    validateConnectionDraft,
} from './claudeRoutineSectionLogic';
import { type ClaudeRoutineConnectionState, useClaudeRoutineConnection } from './useClaudeRoutineConnection';

/** Settings → "Claude routine": connect the Claude Code cloud routine that "Ask Claude" starts. */
export function ClaudeRoutineSection() {
    return <ClaudeRoutineSectionView state={useClaudeRoutineConnection()} />;
}

/** The section for a given connection state — split out so every state has a story. */
export function ClaudeRoutineSectionView({ state }: { state: ClaudeRoutineConnectionState }) {
    if (state.loadError || state.connection === null) {
        return (
            <div className={styles.root} data-testid="claudeRoutineSection">
                <LoadStatus state={state} />
            </div>
        );
    }
    const isFormShown = !state.connection.connected || state.isReplacing;
    return (
        <div className={styles.root} data-testid="claudeRoutineSection">
            {state.connection.connected && (
                <ConnectedStatus state={state} label={describeStoredConnection(state.connection.claudeRoutineId, state.connection.tokenHint)} />
            )}
            {isFormShown && <SetupSteps />}
            {isFormShown && <ConnectionForm state={state} />}
            {state.actionError && (
                <Text variant="bodySm" tone="error" role="alert" data-testid="claudeRoutineError">
                    {state.actionError}
                </Text>
            )}
        </div>
    );
}

function LoadStatus({ state }: { state: ClaudeRoutineConnectionState }) {
    if (state.loadError) {
        return (
            <div className={styles.status}>
                <Text variant="bodySm" tone="error" data-testid="claudeRoutineStatus">
                    {state.loadError}
                </Text>
                <Button size="sm" onClick={state.retryLoad} disabled={!state.isOnline} data-testid="claudeRoutineRetryButton">
                    Retry
                </Button>
            </div>
        );
    }
    return (
        <Text variant="bodySm" tone="secondary" data-testid="claudeRoutineStatus">
            {state.isOnline ? 'Loading…' : 'Connect to the internet to see your Claude routine.'}
        </Text>
    );
}

function ConnectedStatus({ state, label }: { state: ClaudeRoutineConnectionState; label: string }) {
    const isDisabled = state.isPending || !state.isOnline;
    return (
        <div className={styles.status}>
            <Text variant="bodySm" data-testid="claudeRoutineStatus">
                Connected: {label}
            </Text>
            <div className={styles.actions}>
                <Button size="sm" onClick={state.startReplacing} disabled={isDisabled || state.isReplacing} data-testid="claudeRoutineReplaceButton">
                    Replace
                </Button>
                <Button size="sm" tone="danger" onClick={state.disconnect} disabled={isDisabled} data-testid="claudeRoutineDisconnectButton">
                    Disconnect
                </Button>
            </div>
        </div>
    );
}

function SetupSteps() {
    return (
        <>
            <ol className={styles.steps}>
                <li>
                    On{' '}
                    <a href={CLAUDE_ROUTINES_URL} target="_blank" rel="noopener noreferrer">
                        claude.ai/code/routines
                    </a>
                    , create a Claude routine with the Done connector (and any others you want Claude to use, such as Gmail or Jira).
                </li>
                <li>Paste the prompt below as its instructions.</li>
                <li>Add an API trigger, then paste its id (trig_…) and token (sk-ant-oat01-…) here. The token is shown only once.</li>
            </ol>
            <div className={styles.prompt}>
                <p className={styles.promptText} data-testid="claudeRoutineSuggestedPrompt">
                    {SUGGESTED_CLAUDE_ROUTINE_PROMPT}
                </p>
                <CopyButton value={SUGGESTED_CLAUDE_ROUTINE_PROMPT} label="Copy prompt" testId="claudeRoutinePromptCopyButton" />
            </div>
        </>
    );
}

function ConnectionForm({ state }: { state: ClaudeRoutineConnectionState }) {
    const [claudeRoutineId, setClaudeRoutineId] = useState('');
    const [token, setToken] = useState('');
    const [problem, setProblem] = useState<DraftProblem | null>(null);
    const isDisabled = state.isPending || !state.isOnline;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        const found = validateConnectionDraft({ claudeRoutineId, token });
        setProblem(found);
        if (found === null && (await state.save({ claudeRoutineId, token }))) {
            setToken('');
        }
    }

    return (
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
            <TextField
                label="Claude routine id"
                value={claudeRoutineId}
                onChange={(e) => setClaudeRoutineId(e.target.value)}
                placeholder="trig_…"
                fullWidth
                error={problem?.field === 'claudeRoutineId'}
                helperText={problemText(problem, 'claudeRoutineId')}
                data-testid="claudeRoutineIdInput"
            />
            <TextField
                label="Token"
                type="password"
                // new-password: a password manager must not offer a saved login here.
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-ant-oat01-…"
                fullWidth
                error={problem?.field === 'token'}
                helperText={problemText(problem, 'token')}
                data-testid="claudeRoutineTokenInput"
            />
            <div className={styles.actions}>
                <Button type="submit" size="sm" variant="solid" disabled={isDisabled} loading={state.isPending} data-testid="claudeRoutineSaveButton">
                    {state.isReplacing ? 'Save new Claude routine' : 'Connect Claude routine'}
                </Button>
                {state.isReplacing && (
                    <Button size="sm" onClick={state.cancelReplacing} data-testid="claudeRoutineCancelButton">
                        Cancel
                    </Button>
                )}
            </div>
            {!state.isOnline && (
                <Text variant="caption" tone="secondary">
                    Connecting a Claude routine needs a connection.
                </Text>
            )}
        </form>
    );
}

/** The validation message under the field it is about. */
function problemText(problem: DraftProblem | null, field: DraftProblem['field']) {
    return problem?.field === field ? <span data-testid="claudeRoutineValidationError">{problem.message}</span> : undefined;
}
