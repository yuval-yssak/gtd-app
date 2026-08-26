import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { DisabledCapableTooltip } from './DisabledCapableTooltip';
import styles from './stageLayout.module.css';

/** The forward arrow's meaning is contextual (live queue: "skip"; revisit view: "toward the live queue"), so the caller names it. */
interface ForwardAction {
    onForward: () => void;
    disabled?: boolean;
    label: string;
    /** Overrides the default `stageNavForward` — the reassign-blocked fallback keeps its own id. */
    testId?: string;
}

interface StageNavButtonsProps {
    /** Steps backward: un-defers the most recent skip, or into this stage's decision history. */
    onBack: () => void;
    backDisabled?: boolean;
    /** Contextual ◀ meaning (un-skip vs revisit) — mirrored into the tooltip and aria-label. */
    backLabel?: string;
    /** Omitted → no forward arrow (the all-reviewed card only navigates backward). */
    forward?: ForwardAction | undefined;
}

/**
 * The ◀ ▶ pair anchoring the item-level slot of the pinned bar (margin-right: auto pushes the
 * decision buttons right). ◀ un-defers the last skip or revisits past decisions; ▶ is the old
 * "Skip for now" in live mode and plain forward navigation while revisiting.
 */
export function StageNavButtons({ onBack, backDisabled, backLabel = 'Revisit previous decision', forward }: StageNavButtonsProps) {
    return (
        <Box className={styles.navArrows}>
            <DisabledCapableTooltip title={backLabel}>
                {/* size="small" (34px) keeps the text buttons (36.5px) as the bar's height
                    driver — a medium IconButton (40px) would nudge the pinned bar's top edge
                    on stages whose bar has no arrows. */}
                <IconButton size="small" onClick={onBack} disabled={backDisabled} aria-label={backLabel} data-testid="stageNavBack">
                    <ArrowBackIcon />
                </IconButton>
            </DisabledCapableTooltip>
            {forward && (
                <DisabledCapableTooltip title={forward.label}>
                    <IconButton
                        size="small"
                        onClick={forward.onForward}
                        disabled={forward.disabled}
                        aria-label={forward.label}
                        data-testid={forward.testId ?? 'stageNavForward'}
                    >
                        <ArrowForwardIcon />
                    </IconButton>
                </DisabledCapableTooltip>
            )}
        </Box>
    );
}
