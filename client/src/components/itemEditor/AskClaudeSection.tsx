import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { ChevronDown, ExternalLink, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button, Text, TextField, Toast } from '../../designSystem';
import { formatDisplayDate } from '../../lib/displayDate';
import { hasAtLeastOne, type NonEmptyArray } from '../../lib/typeUtils';
import type { StoredClaudeAsk } from '../../types/MyDB';
import { DisabledCapableTooltip } from '../DisabledCapableTooltip';
import styles from './AskClaudeSection.module.css';
import {
    ASK_CLAUDE_LABEL,
    ASK_CLAUDE_OPEN_SESSION_LABEL,
    ASK_CLAUDE_PLACEHOLDER,
    ASK_CLAUDE_PROMPT_LABEL,
    ASK_CLAUDE_PROMPT_MAX_CHARS,
    ASK_CLAUDE_STARTED_NOTICE,
    ASK_HISTORY_PREVIEW_COUNT,
    describeAskButton,
    describeAskResult,
    describePromptCounter,
    isClaudeSessionLink,
    isSubmitChord,
    visibleAsks,
} from './askClaudeLogic';
import type { AskClaudeState } from './useAskClaude';

interface AskClaudeSectionProps {
    state: AskClaudeState;
    /** This item's asks, newest first (`asksForItem`). */
    asks: StoredClaudeAsk[];
    /**
     * Rest as a one-line "Ask Claude" disclosure — the Weekly Review card has a fixed height budget
     * (weekly-review-card-fits) that an open composer would push past. Latches open once expanded.
     */
    isCollapsible?: boolean | undefined;
}

/**
 * "Ask Claude" on one item: a prompt that starts the owner's Claude routine (a Claude Code cloud
 * routine — not a Done routine), and the history of earlier asks with Claude's reports. The
 * session runs in Anthropic's cloud; Done only records it and links to it.
 */
export function AskClaudeSection({ state, asks, isCollapsible = false }: AskClaudeSectionProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    if (isCollapsible && !isExpanded) {
        return (
            <section className={styles.section} aria-label={ASK_CLAUDE_LABEL} data-testid="askClaudeSection">
                <div>
                    <Button size="sm" tone="neutral" startIcon={<ChevronDown />} onClick={() => setIsExpanded(true)} data-testid="askClaudeExpandButton">
                        {hasAtLeastOne(asks) ? `${ASK_CLAUDE_LABEL} · ${asks.length} earlier` : ASK_CLAUDE_LABEL}
                    </Button>
                </div>
            </section>
        );
    }
    return (
        <section className={styles.section} aria-label={ASK_CLAUDE_LABEL} data-testid="askClaudeSection">
            {/* Opening the disclosure unmounts the focused button — hand focus to the prompt so a keyboard
                reviewer is not dropped onto <body>. Only then: the item page and Inbox never steal focus. */}
            <Composer state={state} isAutoFocused={isCollapsible && isExpanded} />
            {state.error && <AskError message={state.error.message} isSettingsFix={state.error.isSettingsFix} />}
            {hasAtLeastOne(asks) && <AskHistory asks={asks} />}
            <Toast
                open={state.startedSessionUrl !== null}
                autoHideDuration={8000}
                onClose={state.dismissStarted}
                message={ASK_CLAUDE_STARTED_NOTICE}
                action={state.startedSessionUrl && <SessionLink url={state.startedSessionUrl} testId="askClaudeStartedSessionLink" />}
                data-testid="askClaudeStartedNotice"
            />
        </section>
    );
}

function Composer({ state, isAutoFocused }: { state: AskClaudeState; isAutoFocused: boolean }) {
    const button = describeAskButton({ isOnline: state.isOnline, isSending: state.isSending, prompt: state.prompt });
    return (
        <div className={styles.composer}>
            <TextField
                label={ASK_CLAUDE_PROMPT_LABEL}
                autoFocus={isAutoFocused}
                value={state.prompt}
                onChange={(e) => state.setPrompt(e.target.value)}
                inputProps={{ maxLength: ASK_CLAUDE_PROMPT_MAX_CHARS }}
                helperText={describePromptCounter(state.prompt) ?? undefined}
                placeholder={ASK_CLAUDE_PLACEHOLDER}
                multiline
                minRows={2}
                fullWidth
                // Mod+Enter sends — and must stop here: the editor root maps the same chord to Save
                // even inside a textarea (lib/editorShortcuts.ts).
                onKeyDown={(e) => {
                    if (isSubmitChord(e)) {
                        e.preventDefault();
                        e.stopPropagation();
                        state.submit();
                    }
                }}
                data-testid="askClaudePrompt"
            />
            <SendButton isDisabled={button.isDisabled} tooltip={button.tooltip} isSending={state.isSending} onSend={state.submit} />
        </div>
    );
}

function SendButton({ isDisabled, tooltip, isSending, onSend }: { isDisabled: boolean; tooltip: string | null; isSending: boolean; onSend: () => void }) {
    const button = (
        <Button size="sm" variant="solid" startIcon={<Sparkles />} disabled={isDisabled} loading={isSending} onClick={onSend} data-testid="askClaudeButton">
            {ASK_CLAUDE_LABEL}
        </Button>
    );
    return tooltip ? <DisabledCapableTooltip title={tooltip}>{button}</DisabledCapableTooltip> : button;
}

function AskError({ message, isSettingsFix }: { message: string; isSettingsFix: boolean }) {
    return (
        <div className={styles.errorRow} role="alert" data-testid="askClaudeError">
            <Text variant="bodySm" tone="error">
                {message}
            </Text>
            {isSettingsFix && (
                <Link to="/settings" className={styles.link} data-testid="askClaudeSettingsLink">
                    Open Settings
                </Link>
            )}
        </div>
    );
}

function AskHistory({ asks }: { asks: NonEmptyArray<StoredClaudeAsk> }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const isTruncated = asks.length > ASK_HISTORY_PREVIEW_COUNT;
    return (
        <>
            <ul className={styles.history} aria-label="Earlier asks" data-testid="askClaudeHistory">
                {visibleAsks(asks, isExpanded).map((ask) => (
                    <AskRow key={ask._id} ask={ask} isPromptClamped={!isExpanded} />
                ))}
            </ul>
            {isTruncated && !isExpanded && (
                <div>
                    <Button size="sm" tone="neutral" onClick={() => setIsExpanded(true)} data-testid="askClaudeShowAll">
                        Show all {asks.length}
                    </Button>
                </div>
            )}
        </>
    );
}

/** One earlier ask. The prompt is clamped in the preview and shown in full once the list is expanded. */
function AskRow({ ask, isPromptClamped }: { ask: StoredClaudeAsk; isPromptClamped: boolean }) {
    const result = describeAskResult(ask);
    return (
        <li className={styles.row} data-testid="askClaudeRow" data-ask-id={ask._id}>
            <div className={styles.rowHeader}>
                <Text as="span" variant="caption" tone="secondary">
                    {formatDisplayDate(dayjs(ask.createdTs), 'MMM D')} · {dayjs(ask.createdTs).format('h:mm A')}
                </Text>
                <SessionLink url={ask.sessionUrl} testId="askClaudeSessionLink" />
            </div>
            <Text variant="bodySm" className={styles.prompt} data-clamped={isPromptClamped || undefined} title={ask.prompt}>
                {ask.prompt}
            </Text>
            <Text variant="bodySm" className={styles.result} data-tone={result.tone} data-testid="askClaudeRowResult">
                {result.text}
            </Text>
        </li>
    );
}

function SessionLink({ url, testId }: { url: string; testId: string }) {
    if (!isClaudeSessionLink(url)) {
        return null;
    }
    return (
        <a href={url} target="_blank" rel="noopener noreferrer" className={styles.link} data-testid={testId}>
            {ASK_CLAUDE_OPEN_SESSION_LABEL}
            <ExternalLink className={styles.icon} aria-hidden="true" />
        </a>
    );
}
