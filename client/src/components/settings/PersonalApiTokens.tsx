import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
    type ApiTokenScope,
    createToken,
    DEFAULT_NEW_TOKEN_SCOPES,
    listTokens,
    MINTABLE_API_TOKEN_SCOPES,
    type PersonalApiToken,
    revokeToken,
    TokensApiError,
} from '../../api/tokensApi';
import {
    AlertDialog,
    Button,
    Checkbox,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogDescription,
    DialogTitle,
    IconButton,
    Text,
    TextField,
    Tooltip,
} from '../../designSystem';
import styles from './PersonalApiTokens.module.css';

dayjs.extend(relativeTime);

const SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
    'items.capture': 'Create inbox items',
    'items.read': 'List, search, and read items',
    'items.write': 'Clarify, update, and complete items',
    'routines.read': 'List and read routines',
    'routines.write': 'Create, update, pause/resume, and split routines',
    'people.read': 'List and read people',
    'people.write': 'Create, update, and delete people',
    'contexts.read': 'List and read work contexts',
    'contexts.write': 'Create, update, and delete work contexts',
    reassign: 'Move items / routines OUT of this account into another account',
    'reassign.accept': 'Allow other accounts to move items / routines INTO this account',
    'webhooks.manage': 'Register and manage webhook subscriptions',
};

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

    function onCreateSubmit(label: string, scopes: ApiTokenScope[]) {
        setActionError(null);
        startCreating(async () => {
            try {
                const created = await createToken(label, scopes);
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
            <Text variant="bodySm" tone="secondary" className={styles.loadingState}>
                Loading tokens…
            </Text>
        );
    }
    if (loadError) {
        return (
            <Text variant="bodySm" tone="error">
                {loadError}
            </Text>
        );
    }
    return (
        <div>
            <TokenList tokens={tokens} onRevoke={openRevoke} revokingId={revokingId} onCreate={openCreate} />
            {actionError && (
                <Text variant="bodySm" tone="error" className={styles.actionError} data-testid="tokensActionError">
                    {actionError}
                </Text>
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
        </div>
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
            <div>
                <Text variant="bodySm" tone="secondary" className={styles.emptyState} data-testid="tokensEmptyState">
                    No API tokens yet.
                </Text>
                <Button variant="outline" size="sm" onClick={onCreate} data-testid="createTokenButton">
                    Create token
                </Button>
            </div>
        );
    }
    return (
        <div>
            <ul className={styles.list} data-testid="tokenList">
                {tokens.map((t) => (
                    <TokenRow key={t.id} token={t} onRevoke={onRevoke} isRevoking={revokingId === t.id} />
                ))}
            </ul>
            <Button variant="outline" size="sm" onClick={onCreate} className={styles.createButton} data-testid="createTokenButton">
                Create token
            </Button>
        </div>
    );
}

interface TokenRowProps {
    token: PersonalApiToken;
    onRevoke: (token: PersonalApiToken) => void;
    isRevoking: boolean;
}

/** Active tokens whose lastUsedTs is older than this (or never set) earn the "unused" chip,
 * giving users a visual signal of which rows are safe to revoke. 90 days matches typical
 * security-hygiene guidance for personal-access tokens. */
export const UNUSED_THRESHOLD_DAYS = 90;

/** Exported for unit tests; pure (modulo `dayjs()` clock) so it can be tested without rendering. */
export function isTokenUnused(token: PersonalApiToken, now: dayjs.Dayjs = dayjs()): boolean {
    if (token.revokedTs !== undefined) {
        return false;
    }
    if (!token.lastUsedTs) {
        return true;
    }
    return now.diff(dayjs(token.lastUsedTs), 'day') >= UNUSED_THRESHOLD_DAYS;
}

function TokenRow({ token, onRevoke, isRevoking }: TokenRowProps) {
    const isRevoked = token.revokedTs !== undefined;
    const created = `Created ${dayjs(token.createdTs).format('MMM D, YYYY')}`;
    const lastUsed = token.lastUsedTs ? `Last used ${dayjs().to(dayjs(token.lastUsedTs))}` : 'Never used';
    const secondary = isRevoked ? `${created} · Revoked ${dayjs(token.revokedTs).format('MMM D, YYYY')}` : `${created} · ${lastUsed}`;
    const showUnusedChip = isTokenUnused(token);
    return (
        <li className={styles.row} data-revoked={isRevoked || undefined} data-testid="tokenRow">
            <div className={styles.rowText}>
                <span className={styles.primaryLine}>
                    <Text as="span">{token.label}</Text>
                    {showUnusedChip && <Chip variant="outline" label="unused" data-testid="unusedTokenChip" />}
                    {/* Render the raw scope string — never index SCOPE_DESCRIPTIONS here. `scopes` is
                        typed ApiTokenScope[] but populated from untyped network JSON, so a row can carry
                        a value outside the current union (e.g. a not-yet-migrated legacy scope). The raw
                        label keeps that chip rendering instead of crashing on a missing description key. */}
                    {token.scopes.map((scope) => (
                        <Chip key={scope} variant="outline" label={scope} data-testid="tokenScopeChip" />
                    ))}
                </span>
                <Text as="span" variant="bodySm" tone="secondary">
                    {secondary}
                </Text>
            </div>
            {!isRevoked && (
                <Button size="sm" tone="danger" onClick={() => onRevoke(token)} disabled={isRevoking} data-testid="revokeTokenButton">
                    {isRevoking ? 'Revoking…' : 'Revoke'}
                </Button>
            )}
        </li>
    );
}

interface CreateDialogProps {
    state: CreateState;
    onCancel: () => void;
    onSubmit: (label: string, scopes: ApiTokenScope[]) => void;
    onDismissReveal: () => void;
    isCreating: boolean;
}

function CreateDialog({ state, onCancel, onSubmit, onDismissReveal, isCreating }: CreateDialogProps) {
    const [label, setLabel] = useState('');
    const [labelError, setLabelError] = useState<string | null>(null);
    const [scopes, setScopes] = useState<Set<ApiTokenScope>>(() => new Set(DEFAULT_NEW_TOKEN_SCOPES));
    const [scopesError, setScopesError] = useState<string | null>(null);
    const [copyError, setCopyError] = useState<string | null>(null);
    // The reveal's acknowledge button takes focus, so Enter dismisses only once the user is ready.
    const dismissButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (state.phase === 'form') {
            setLabel('');
            setLabelError(null);
            setScopes(new Set(DEFAULT_NEW_TOKEN_SCOPES));
            setScopesError(null);
        }
        if (state.phase === 'reveal') {
            setCopyError(null);
        }
    }, [state.phase]);

    function toggleScope(scope: ApiTokenScope) {
        setScopes((prev) => {
            const next = new Set(prev);
            if (next.has(scope)) {
                next.delete(scope);
            } else {
                next.add(scope);
            }
            return next;
        });
        if (scopesError !== null) setScopesError(null);
    }

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
            if (scopes.size === 0) {
                setScopesError('Pick at least one capability.');
                return;
            }
            onSubmit(trimmed, [...scopes]);
        }
        return (
            <Dialog open onClose={onCancel} size="sm" fullWidth data-testid="createTokenDialog">
                <DialogTitle>Create API token</DialogTitle>
                <DialogContent>
                    <DialogDescription className={styles.formIntro}>
                        Give your token a label so you can identify it later (e.g. "iOS Shortcut", "Local MCP").
                    </DialogDescription>
                    <TextField
                        autoFocus
                        fullWidth
                        size="sm"
                        label="Label"
                        value={label}
                        onChange={(e) => {
                            setLabel(e.target.value);
                            if (labelError !== null) setLabelError(null);
                        }}
                        error={labelError !== null}
                        helperText={labelError ?? undefined}
                        autoComplete="off"
                        data-testid="tokenLabelInput"
                    />
                    <fieldset className={styles.scopesGroup}>
                        <Text as="legend" variant="bodySm" weight="medium" className={styles.scopesLabel}>
                            Capabilities
                        </Text>
                        {MINTABLE_API_TOKEN_SCOPES.map((scope) => (
                            <Checkbox
                                key={scope}
                                size="sm"
                                checked={scopes.has(scope)}
                                onCheckedChange={() => toggleScope(scope)}
                                data-testid={`scopeCheckbox-${scope}`}
                                label={
                                    <span>
                                        <Text as="span" variant="bodySm">
                                            <code>{scope}</code>
                                        </Text>
                                        <Text as="span" variant="caption" tone="secondary">
                                            {' '}
                                            — {SCOPE_DESCRIPTIONS[scope]}
                                        </Text>
                                    </span>
                                }
                            />
                        ))}
                        {scopesError && (
                            <Text variant="caption" tone="error" className={styles.scopesError} data-testid="scopesError">
                                {scopesError}
                            </Text>
                        )}
                    </fieldset>
                </DialogContent>
                <DialogActions>
                    <Button onClick={onCancel}>Cancel</Button>
                    <Button variant="solid" onClick={handleCreate} disabled={isCreating} data-testid="confirmCreateTokenButton">
                        {isCreating ? 'Creating…' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    // Reveal phase: this is the only time the plaintext is in the DOM. Escape and the backdrop are
    // no-ops so the user must explicitly acknowledge they copied it.
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
            // A no-op close keeps the controlled dialog open on Escape and backdrop clicks — it
            // stays pinned until the user clicks "I've copied it".
            onClose={() => {}}
            disableBackdropClose
            initialFocus={dismissButtonRef}
            size="sm"
            fullWidth
            data-testid="tokenRevealDialog"
        >
            <DialogTitle>Token created</DialogTitle>
            <DialogContent>
                <DialogDescription className={styles.warning}>
                    This is the only time you will see this token. Store it somewhere safe before closing.
                </DialogDescription>
                <div className={styles.plaintextBox}>
                    <span className={styles.plaintextText} data-testid="tokenPlaintext">
                        {state.plaintext}
                    </span>
                    <Tooltip title="Copy to clipboard">
                        <IconButton size="sm" onClick={() => void copyPlaintext()} data-testid="copyTokenButton" aria-label="Copy token to clipboard">
                            <Copy />
                        </IconButton>
                    </Tooltip>
                </div>
                <Text as="span" variant="caption" tone="secondary" className={styles.labelCaption}>
                    Label: {state.label}
                </Text>
                {copyError && (
                    <Text variant="bodySm" tone="error" className={styles.copyError} data-testid="copyTokenError">
                        {copyError}
                    </Text>
                )}
            </DialogContent>
            <DialogActions>
                <Button ref={dismissButtonRef} variant="solid" onClick={onDismissReveal} data-testid="dismissRevealButton">
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
        <AlertDialog open onClose={onCancel} size="xs" data-testid="revokeTokenDialog">
            <DialogTitle>Revoke token</DialogTitle>
            <DialogDescription>
                Revoke <strong>{state.token.label}</strong>? Any integration using this token will stop working immediately.
            </DialogDescription>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant="solid" tone="danger" onClick={onConfirm} disabled={isRevoking} data-testid="confirmRevokeTokenButton">
                    {isRevoking ? 'Revoking…' : 'Revoke'}
                </Button>
            </DialogActions>
        </AlertDialog>
    );
}
