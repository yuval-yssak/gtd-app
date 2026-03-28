import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';

export const Route = createFileRoute('/_authenticated/weekly-review')({
    component: WeeklyReviewPage,
});

interface ReviewStep {
    id: string;
    phase: string;
    tasks: { id: string; label: string }[];
}

const reviewSteps: ReviewStep[] = [
    {
        id: 'get-clear',
        phase: 'Get Clear',
        tasks: [
            { id: 'empty-inbox', label: 'Empty the inbox to zero' },
            { id: 'process-notes', label: 'Process all loose notes and scraps' },
            { id: 'clear-desk', label: 'Clear your physical and digital desktops' },
        ],
    },
    {
        id: 'get-current',
        phase: 'Get Current',
        tasks: [
            { id: 'review-next-actions', label: 'Review Next Actions list — delete or complete stale items' },
            { id: 'review-waiting', label: 'Review Waiting For list — follow up where needed' },
            { id: 'review-calendar-past', label: 'Scan the past 2 weeks of calendar for any loose ends' },
            { id: 'review-calendar-future', label: 'Scan the next 2 weeks of calendar for prep needed' },
            { id: 'review-tickler', label: 'Review Tickler — are future dates still correct?' },
        ],
    },
    {
        id: 'get-creative',
        phase: 'Get Creative',
        tasks: [
            { id: 'review-someday', label: 'Review Someday / Maybe — promote or delete items' },
            { id: 'review-routines', label: 'Review Routines — are they still relevant?' },
            { id: 'brainstorm', label: 'Capture any new ideas, projects, or commitments' },
        ],
    },
];

// localStorage key for persisting review progress across sessions
const STORAGE_KEY = 'gtd:weeklyReview';

interface ReviewState {
    checked: Record<string, boolean>;
    completedAt: string | null;
}

function loadState(): ReviewState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw) as ReviewState;
    } catch {
        // ignore parse errors from corrupted storage
    }
    return { checked: {}, completedAt: null };
}

function saveState(state: ReviewState): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function WeeklyReviewPage() {
    const [state, setState] = useState<ReviewState>(loadState);

    const allTaskIds = reviewSteps.flatMap((s) => s.tasks.map((t) => t.id));
    const checkedCount = allTaskIds.filter((id) => state.checked[id]).length;
    const progress = allTaskIds.length > 0 ? (checkedCount / allTaskIds.length) * 100 : 0;
    const isComplete = checkedCount === allTaskIds.length;

    function toggleTask(taskId: string) {
        setState((prev) => {
            const next: ReviewState = { ...prev, checked: { ...prev.checked, [taskId]: !prev.checked[taskId] } };
            saveState(next);
            return next;
        });
    }

    function onComplete() {
        setState((prev) => {
            const next: ReviewState = { ...prev, completedAt: dayjs().toISOString() };
            saveState(next);
            return next;
        });
    }

    function onReset() {
        const next: ReviewState = { checked: {}, completedAt: null };
        saveState(next);
        setState(next);
    }

    return (
        <Box sx={{ maxWidth: 600 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="h5" fontWeight={600}>
                    Weekly Review
                </Typography>
                {state.completedAt && (
                    <Typography variant="caption" color="text.secondary">
                        Last completed {dayjs(state.completedAt).format('MMM D')}
                    </Typography>
                )}
            </Box>

            <Box sx={{ mb: 3 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">
                        {checkedCount} / {allTaskIds.length} tasks
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        {Math.round(progress)}%
                    </Typography>
                </Box>
                <LinearProgress variant="determinate" value={progress} sx={{ borderRadius: 1 }} />
            </Box>

            {reviewSteps.map((step) => (
                <Paper key={step.id} variant="outlined" sx={{ mb: 2, p: 2 }}>
                    <Typography variant="subtitle2" fontWeight={700} color="primary" mb={1}>
                        {step.phase}
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                        {step.tasks.map((task) => (
                            <FormControlLabel
                                key={task.id}
                                control={<Checkbox checked={!!state.checked[task.id]} onChange={() => toggleTask(task.id)} size="small" />}
                                label={<Typography variant="body2">{task.label}</Typography>}
                                sx={{ alignItems: 'flex-start', '& .MuiCheckbox-root': { pt: 0.5 } }}
                            />
                        ))}
                    </Box>
                </Paper>
            ))}

            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                {!state.completedAt && (
                    <Button variant="contained" disabled={!isComplete} onClick={onComplete}>
                        Mark review complete
                    </Button>
                )}
                <Button variant="outlined" onClick={onReset}>
                    Start over
                </Button>
            </Box>

            {state.completedAt && (
                <Typography variant="body2" color="success.main" mt={2}>
                    Review completed {dayjs(state.completedAt).format('dddd, MMM D [at] h:mm a')}. Great work!
                </Typography>
            )}
        </Box>
    );
}
