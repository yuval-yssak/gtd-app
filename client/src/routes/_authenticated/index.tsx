import { createFileRoute } from '@tanstack/react-router'
import Typography from '@mui/material/Typography'

export const Route = createFileRoute('/_authenticated/')({
    component: HomePage,
})

function HomePage() {
    return <Typography variant="h6">Welcome! Your GTD inbox will appear here.</Typography>
}
