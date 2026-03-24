import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/')({
    component: HomePage,
});

function HomePage() {
    return <Typography variant="h6">Welcome! Your GTD inbox will appear here.</Typography>;
}
