import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import classNames from 'classnames';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { createToken, listTokens, type PersonalApiToken, revokeToken, TokensApiError } from '../../api/tokensApi';
import styles from './PersonalApiTokens.module.css';

dayjs.extend(relativeTime);

type CreateState = { phase: 'closed' } | { phase: 'form' } | { phase: 'reveal'; plaintext: string; label: string };
type RevokeState = { phase: 'closed' } | { phase: 'confirm'; token: PersonalApiToken };

export function PersonalApiTokens() {
    const [tokens, setTokens] = useState<PersonalApiToken[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [createState, setCreateState] = useState<CreateState>({ phase: 'closed' });
    const [revokeState, setRevokeState] = useState<RevokeState>({ phase: 'closed' });
    const [actionError, setActionError] = useState<string | null>(null);
    const [isCreating, startCreating] = useTransition();
    const [revokingId, setRevokingId] = useState<string | null>(null);
    // isMountedRef guards setState calls in refresh against post-unmount updates,
    // mirroring the pattern in CalendarIntegrations.tsx.
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        setLoadError(null);
        try {
            const fetched = await listTokens();
            if (isMountedRef.current) {
                setTokens(fetched);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setLoadError(err instanceof Error ? err.message : 'Failed to load tokens.');
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    function openCreate() {
        setActionError(null);
        setCreateState({ phase: 'form' });
    }

    function onCreateSubmit(label: string) {
        setActionError(null);
        startCreating(async () => {
            try {
                const created = await createToken(label);
                setCreateState({ phase: 'reveal', plaintext: created.plaintext, label: created.label });
                await refresh();
            } catch (err) {
                if (err instanceof TokensApiError && err.code === 'token_cap_reached') {
                    setActionError(err.message);
                } else {
                    setActionError(err instanceof Error ? err.message : 'Failed to create token.');
                }
            }
        });
    }

    function dismissReveal() {
        setCreateState({ phase: 'closed' });
    }

    function openRevoke(token: PersonalApiToken) {
        setActionError(null);
        setRevokeState({ phase: 'confirm', token });
    }

    async function onRevokeConfirm() {
        if (revokeState.phase !== 'confirm') {
            return;
        }
        const id = revokeState.token.id;
        setRevokingId(id);
        try {
            await revokeToken(id);
            setRevokeState({ phase: 'closed' });
            await refresh();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to revoke token.');
        } finally {
            setRevokingId(null);
        }
    }

    if (isLoading) {
        return (
            <Typography variant="body2" className={styles.loadingState}>
                Loading tokens…
            </Typography>
        );
    }
    if (loadError) {
        return (
            <Typography variant="body2" className={styles.loadError}>
                {loadError}
            </Typography>
        );
    }
    return (
        <Box>
            <TokenList tokens={tokens} onRevoke={openRevoke} revokingId={revokingId} onCreate={openCreate} />
            {actionError && (
                <Typography variant="body2" className={styles.actionError} sx={{ mt: 1 }} data-testid="tokensActionError">
                    {actionError}
                </Typography>
            )}
            <CreateDialog
                state={createState}
                onCancel={() => setCreateState({ phase: 'closed' })}
                onSubmit={onCreateSubmit}
                onDismissReveal={dismissReveal}
                isCreating={isCreating}
            />
            <RevokeDialog
                state={revokeState}
                onCancel={() => setRevokeState({ phase: 'closed' })}
                onConfirm={onRevokeConfirm}
                isRevoking={revokingId !== null}
            />
        </Box>
    );
}

interface TokenListProps {
    tokens: PersonalApiToken[];
    onRevoke: (token: PersonalApiToken) => void;
    revokingId: string | null;
    onCreate: () => void;
}

function TokenList({ tokens, onRevoke, revokingId, onCreate }: TokenListProps) {
    if (tokens.length === 0) {
        return (
            <Box>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }} data-testid="tokensEmptyState">
                    No API tokens yet.
                </Typography>
                <Button variant="outlined" size="small" onClick={onCreate} data-testid="createTokenButton">
                    Create token
                </Button>
            </Box>
        );
    }
    return (
        <Box>
            <List dense disablePadding data-testid="tokenList">
                {tokens.map((t) => (
                    <TokenRow key={t.id} token={t} onRevoke={onRevoke} isRevoking={revokingId === t.id} />
                ))}
            </List>
            <Button variant="outlined" size="small" onClick={onCreate} sx={{ mt: 1 }} data-testid="createTokenButton">
                Create token
            </Button>
        </Box>
    );
}

interface TokenRowProps {
    token: PersonalApiToken;
    onRevoke: (token: PersonalApiToken) => void;
    isRevoking: boolean;
}

function TokenRow({ token, onRevoke, isRevoking }: TokenRowProps) {
    const isRevoked = token.revokedTs !== undefined;
    const created = `Created ${dayjs(token.createdTs).format('MMM D, YYYY')}`;
    const lastUsed = token.lastUsedTs ? `Last used ${dayjs().to(dayjs(token.lastUsedTs))}` : 'Never used';
    const secondary = isRevoked ? `${created} · Revoked ${dayjs(token.revokedTs).format('MMM D, YYYY')}` : `${created} · ${lastUsed}`;
    return (
        <ListItem
            disableGutters
            data-testid="tokenRow"
            className={classNames(isRevoked && styles.revokedRow)}
            secondaryAction={
                isRevoked ? null : (
                    <Button size="small" color="warning" onClick={() => onRevoke(token)} disabled={isRevoking} data-testid="revokeTokenButton">
                        {isRevoking ? 'Revoking…' : 'Revoke'}
                    </Button>
                )
            }
        >
            <ListItemText primary={token.label} secondary={secondary} />
        </ListItem>
    );
}

interface CreateDialogProps {
    state: CreateState;
    onCancel: () => void;
    onSubmit: (label: string) => void;
    onDismissReveal: () => void;
    isCreating: boolean;
}

function CreateDialog({ state, onCancel, onSubmit, onDismissReveal, isCreating }: CreateDialogProps) {
    const [label, setLabel] = useState('');
    const [labelError, setLabelError] = useState<string | null>(null);
    const [copyError, setCopyError] = useState<string | null>(null);

    useEffect(() => {
        if (state.phase === 'form') {
            setLabel('');
            setLabelError(null);
        }
        if (state.phase === 'reveal') {
            setCopyError(null);
        }
    }, [state.phase]);

    if (state.phase === 'closed') {
        return null;
    }

    if (state.phase === 'form') {
        function handleCreate() {
            const trimmed = label.trim();
            if (trimmed === '') {
                setLabelError('Label is required.');
                return;
            }
            onSubmit(trimmed);
        }
        return (
            <Dialog open onClose={onCancel} data-testid="createTokenDialog">
                <DialogTitle>Create API token</DialogTitle>
                <DialogContent>
                    <DialogContentText sx={{ mb: 2 }}>
                        Give your token a label so you can identify it later (e.g. "iOS Shortcut", "Local MCP").
                    </DialogContentText>
                    <TextField
                        autoFocus
                        fullWidth
                        size="small"
                        label="Label"
                        value={label}
                        onChange={(e) => {
                            setLabel(e.target.value);
                            if (labelError !== null) setLabelError(null);
                        }}
                        error={labelError !== null}
                        helperText={labelError ?? ''}
                        autoComplete="off"
                        data-testid="tokenLabelInput"
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={onCancel}>Cancel</Button>
                    <Button variant="contained" onClick={handleCreate} disabled={isCreating} data-testid="confirmCreateTokenButton">
                        {isCreating ? 'Creating…' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    // Reveal phase: this is the only time the plaintext is in the DOM. Disable Esc and the
    // backdrop-click dismiss path so the user must explicitly acknowledge they copied it.
    async function copyPlaintext() {
        if (state.phase !== 'reveal') {
            return;
        }
        try {
            await navigator.clipboard.writeText(state.plaintext);
            setCopyError(null);
        } catch (err) {
            // navigator.clipboard.writeText rejects on denied permissions, non-focused document, or
            // insecure context. Without surfacing this, the user might dismiss the only-time reveal
            // believing they copied the secret.
            setCopyError(err instanceof Error ? err.message : 'Copy failed. Select the token text manually.');
        }
    }
    return (
        <Dialog
            open
            // reason='backdropClick' is fired on outside-clicks; ignoring it here keeps the modal
            // pinned until the user clicks "I've copied it". Esc is suppressed via disableEscapeKeyDown.
            onClose={(_event, reason) => {
                if (reason === 'backdropClick') {
                    return;
                }
            }}
            disableEscapeKeyDown
            data-testid="tokenRevealDialog"
        >
            <DialogTitle>Token created</DialogTitle>
            <DialogContent>
                <DialogContentText className={styles.warning} sx={{ mb: 1.5 }}>
                    This is the only time you will see this token. Store it somewhere safe before closing.
                </DialogContentText>
                <Box className={styles.plaintextBox}>
                    <Box component="span" className={styles.plaintextText} data-testid="tokenPlaintext">
                        {state.plaintext}
                    </Box>
                    <Tooltip title="Copy to clipboard">
                        <IconButton size="small" onClick={() => void copyPlaintext()} data-testid="copyTokenButton" aria-label="Copy token to clipboard">
                            <ContentCopyIcon fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </Box>
                <Typography variant="caption" component="span" className={styles.labelCaption}>
                    Label: {state.label}
                </Typography>
                {copyError && (
                    <Typography variant="body2" className={styles.copyError} data-testid="copyTokenError">
                        {copyError}
                    </Typography>
                )}
            </DialogContent>
            <DialogActions>
                <Button autoFocus variant="contained" onClick={onDismissReveal} data-testid="dismissRevealButton">
                    I've copied it
                </Button>
            </DialogActions>
        </Dialog>
    );
}

interface RevokeDialogProps {
    state: RevokeState;
    onCancel: () => void;
    onConfirm: () => void;
    isRevoking: boolean;
}

function RevokeDialog({ state, onCancel, onConfirm, isRevoking }: RevokeDialogProps) {
    if (state.phase === 'closed') {
        return null;
    }
    return (
        <Dialog open onClose={onCancel} data-testid="revokeTokenDialog">
            <DialogTitle>Revoke token</DialogTitle>
            <DialogContent>
                <DialogContentText>
                    Revoke <strong>{state.token.label}</strong>? Any integration using this token will stop working immediately.
                </DialogContentText>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="contained" color="warning" onClick={onConfirm} disabled={isRevoking} data-testid="confirmRevokeTokenButton">
                    {isRevoking ? 'Revoking…' : 'Revoke'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
