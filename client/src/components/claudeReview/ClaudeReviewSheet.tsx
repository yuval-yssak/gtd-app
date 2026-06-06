import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RefreshIcon from '@mui/icons-material/Refresh';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import SwipeableDrawer from '@mui/material/SwipeableDrawer';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';
import { AssistApiError, applyProposal, assist, type ClarifyProposal, type ProposedItemPatch } from '#api/assistApi';
import { appliableSideEffect, presentPatch } from '../../lib/proposalPresenter';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './ClaudeReviewSheet.module.css';
import { applyPayloadEdit, describeError, EDITABLE_PAYLOAD_FIELDS, hasAppliableWork, type ReviewErrorView } from './claudeReviewLogic';

interface ClaudeReviewSheetProps {
    item: StoredItem;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    /** Called after a successful apply so the host can pull the server-side write back into IDB. */
    onApplied: () => Promise<void>;
}

type Phase = 'loading' | 'loaded' | 'error';

/** Reads the AssistApiError's code (or undefined for a non-AssistApiError, e.g. a network throw). */
function errorViewOf(err: unknown): ReviewErrorView {
    return describeError(err instanceof AssistApiError ? err.code : undefined);
}

/**
 * Bottom-sheet review of a Claude "Clarify" proposal (issue #21, §8.1). Runs the assist call on open,
 * shows the rewritten title + humanized fields, and offers Apply / inline-Edit / Skip / Apply-All /
 * Ask-again. Only the server-prepended token-bearing side-effect is appliable in v1.
 */
export function ClaudeReviewSheet({ item, people, workContexts, onClose, onApplied }: ClaudeReviewSheetProps) {
    const [phase, setPhase] = useState<Phase>('loading');
    const [proposal, setProposal] = useState<ClarifyProposal | null>(null);
    const [editedPatch, setEditedPatch] = useState<ProposedItemPatch | null>(null);
    const [errorView, setErrorView] = useState<ReviewErrorView | null>(null);
    const [skipped, setSkipped] = useState(false);
    const [editing, setEditing] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [instruction, setInstruction] = useState('');
    // Guards stale async resolutions: a monotonically increasing token per assist call (so a slow
    // earlier Ask-again/retry can't clobber a newer one) and a mounted flag (so a resolution after
    // the sheet closes doesn't setState on an unmounted component).
    const requestSeq = useRef(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    // Run (and re-run, for Ask-again / retry) the clarify call. Seeds editedPatch from the proposal.
    async function runAssist(withInstruction?: string) {
        const seq = ++requestSeq.current;
        setPhase('loading');
        setSkipped(false);
        setEditing(false);
        try {
            const result = await assist(item._id, withInstruction);
            // Drop the result if a newer request started or the sheet unmounted while in flight.
            if (!mounted.current || seq !== requestSeq.current) {
                return;
            }
            setProposal(result);
            setEditedPatch(result.proposedItemPatch ?? null);
            setPhase('loaded');
        } catch (err) {
            if (!mounted.current || seq !== requestSeq.current) {
                return;
            }
            setErrorView(errorViewOf(err));
            setPhase('error');
        }
    }

    // biome-ignore lint/correctness/useExhaustiveDependencies: run once per opened item; runAssist closes over item._id only.
    useEffect(() => {
        void runAssist();
    }, [item._id]);

    const token = proposal ? appliableSideEffect(proposal)?.executeToken : undefined;
    const patch = editedPatch ?? proposal?.proposedItemPatch;
    const canApply = hasAppliableWork(patch, token !== undefined, skipped);

    async function onApply() {
        if (!token || !patch || isApplying) {
            return;
        }
        setIsApplying(true);
        try {
            await applyProposal(token, patch);
            await onApplied();
            onClose(); // unmounts the sheet — no setState afterward (the catch/finally guard mounted).
        } catch (err) {
            if (!mounted.current) {
                return;
            }
            setErrorView(errorViewOf(err));
            setPhase('error');
            setIsApplying(false);
        }
    }

    function onEditField(field: (typeof EDITABLE_PAYLOAD_FIELDS)[number], value: string) {
        setEditedPatch((prev) => applyPayloadEdit(prev ?? {}, field, value));
    }

    return (
        <SwipeableDrawer anchor="bottom" open onClose={onClose} onOpen={() => {}} data-testid="claudeReviewSheet">
            <Box className={styles.sheetHandle} />
            {phase === 'loading' && (
                <Box className={styles.loadingBox} data-testid="claudeReviewLoading">
                    <CircularProgress size={20} />
                    <Typography variant="body2">Asking Claude…</Typography>
                </Box>
            )}
            {phase === 'error' && errorView && (
                <Box className={styles.body}>
                    <Typography color="error" data-testid="claudeReviewError">
                        {errorView.message}
                    </Typography>
                    <Box className={styles.footer}>
                        <Button onClick={onClose}>Close</Button>
                        {errorView.retryable && (
                            <Button variant="contained" onClick={() => void runAssist()} data-testid="claudeReviewRetry">
                                Try again
                            </Button>
                        )}
                    </Box>
                </Box>
            )}
            {phase === 'loaded' && proposal && (
                <Box className={styles.body}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <AutoAwesomeIcon fontSize="small" color="primary" />
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }} data-testid="claudeReviewSummary">
                            {proposal.summary}
                        </Typography>
                    </Box>
                    <Divider />
                    {editing ? (
                        EDITABLE_PAYLOAD_FIELDS.filter((f) => patch?.[f] !== undefined).map((f) => (
                            <TextField
                                key={f}
                                label={f === 'title' ? 'Title' : 'Notes'}
                                value={patch?.[f] ?? ''}
                                onChange={(e) => onEditField(f, e.target.value)}
                                fullWidth
                                multiline={f === 'notes'}
                                size="small"
                                slotProps={{ htmlInput: { 'data-testid': `claudeReviewEditInput-${f}` } }}
                            />
                        ))
                    ) : patch ? (
                        presentPatch(patch, { people, workContexts }).map((row) => (
                            <Box key={row.field} className={styles.fieldRow} data-testid="claudeReviewField">
                                <Typography variant="body2" color="text.secondary" className={styles.fieldLabel}>
                                    {row.label}
                                </Typography>
                                <Typography variant="body2">{row.display}</Typography>
                            </Box>
                        ))
                    ) : (
                        <Typography variant="body2" color="text.secondary">
                            No field changes proposed.
                        </Typography>
                    )}
                    {skipped && (
                        <Typography variant="body2" color="text.secondary" data-testid="claudeReviewSkipped">
                            Skipped — nothing will be applied.
                        </Typography>
                    )}
                    <Box className={styles.askAgainRow}>
                        <TextField
                            label="Ask again with an instruction"
                            value={instruction}
                            onChange={(e) => setInstruction(e.target.value)}
                            fullWidth
                            size="small"
                            placeholder="e.g. make it a calendar event"
                            slotProps={{ htmlInput: { 'data-testid': 'claudeReviewAskAgainInput' } }}
                        />
                        <Tooltip title="Ask Claude again">
                            <span>
                                <IconButton
                                    onClick={() => void runAssist(instruction.trim() || undefined)}
                                    disabled={!instruction.trim()}
                                    data-testid="claudeReviewAskAgain"
                                >
                                    <RefreshIcon />
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Box>
                    <Box className={styles.footer}>
                        <Button color="inherit" onClick={() => setSkipped(true)} disabled={skipped} data-testid="claudeReviewSkip">
                            Skip
                        </Button>
                        <Button onClick={() => setEditing((e) => !e)} disabled={!patch} data-testid="claudeReviewEdit">
                            {editing ? 'Done editing' : 'Edit'}
                        </Button>
                        {/* v1 has exactly one appliable side-effect (the server-prepended itemPatch),
                            so a single Apply is honest. "Apply All" returns when there are >1. */}
                        <Button variant="contained" onClick={() => void onApply()} disabled={!canApply || isApplying} data-testid="claudeReviewApply">
                            Apply
                        </Button>
                    </Box>
                </Box>
            )}
        </SwipeableDrawer>
    );
}
