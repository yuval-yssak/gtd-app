import KeyboardDoubleArrowLeftIcon from '@mui/icons-material/KeyboardDoubleArrowLeft';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import styles from './stageLayout.module.css';

/**
 * Stage-level travel: the ⏪ ⏩ pair pinned to the bar's outer edges on EVERY stage view, one
 * stage back / forward per click (free jumps — no skip marks, no completion requirement). Stages
 * hosting an editor pass a locked variant while a structural edit or save is pending (a stage
 * jump is a state change the router-based unsaved-changes guard can never see).
 */
export interface StageTravel {
    onPrevStage: () => void;
    onNextStage: () => void;
    /** First stage — there is nothing before it. */
    prevDisabled: boolean;
    /** Last stage — finishing the review goes through its Continue, not a nav arrow. */
    nextDisabled: boolean;
}

interface StageActionBarProps {
    travel: StageTravel;
    /** Ref callback receiving the bar's CONTENT element — solo stages feed it to ItemEditorBody's actionsContainer. */
    onBarMounted?: (barEl: HTMLElement | null) => void;
    /**
     * Rendered before any portaled editor actions (i.e. on the content slot's left). Stages use
     * this for content that must survive the editor rendering nothing — nav arrows during a
     * reassign-in-flight early return, the empty card's back arrow + Continue.
     */
    children?: React.ReactNode;
}

/**
 * The stage column's pinned bottom bar — one fixed screen position for every decision button,
 * bracketed by the stage-travel arrows. The double-chevron icons keep them visually distinct from
 * the single-arrow item-level pair (StageNavButtons).
 */
export function StageActionBar({ travel, onBarMounted, children }: StageActionBarProps) {
    return (
        <Paper elevation={4} className={styles.actionBar} data-testid="stageActionBar">
            <TravelArrow label="Previous stage" testId="stageTravelPrev" onNavigate={travel.onPrevStage} disabled={travel.prevDisabled}>
                <KeyboardDoubleArrowLeftIcon />
            </TravelArrow>
            {/* The portal target is this inner slot (not the Paper): portaled editor actions append
                to their container's end, and appending into the Paper would land them AFTER the
                next-stage arrow, breaking the bar's visual order. */}
            <Box className={styles.actionBarContent} ref={onBarMounted}>
                {children}
            </Box>
            <TravelArrow label="Next stage" testId="stageTravelNext" onNavigate={travel.onNextStage} disabled={travel.nextDisabled}>
                <KeyboardDoubleArrowRightIcon />
            </TravelArrow>
        </Paper>
    );
}

interface TravelArrowProps {
    label: string;
    testId: string;
    onNavigate: () => void;
    disabled: boolean;
    children: React.ReactNode;
}

function TravelArrow({ label, testId, onNavigate, disabled, children }: TravelArrowProps) {
    return (
        <Tooltip title={label}>
            {/* span: MUI Tooltips need a focusable child even while the button is disabled */}
            <span>
                <IconButton size="small" onClick={onNavigate} disabled={disabled} aria-label={label} data-testid={testId}>
                    {children}
                </IconButton>
            </span>
        </Tooltip>
    );
}
