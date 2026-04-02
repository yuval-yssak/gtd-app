import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import styles from './someday.module.css';

export const Route = createFileRoute('/_authenticated/someday')({
    component: SomedayPage,
});

function SomedayPage() {
    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Someday / Maybe
            </Typography>
            <Paper variant="outlined" className={styles.emptyCard}>
                <BookmarkAddIcon className={styles.icon} />
                <Typography variant="subtitle1" fontWeight={600} mb={1}>
                    Coming soon
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={3}>
                    Someday / Maybe items are things you're not committed to but don't want to forget. This view requires a data model update and will be
                    available in a future release.
                </Typography>
                <Button variant="outlined" disabled startIcon={<BookmarkAddIcon />}>
                    Add someday item
                </Button>
            </Paper>
        </Box>
    );
}
