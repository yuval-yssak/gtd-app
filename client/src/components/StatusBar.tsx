import CircleIcon from '@mui/icons-material/Circle';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useOnline } from '../hooks/useOnline';

export function StatusBar() {
    const online = useOnline();

    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 2,
                py: 0.5,
                borderTop: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
            }}
        >
            <CircleIcon sx={{ fontSize: 10, color: online ? 'success.main' : 'error.main' }} />
            <Typography variant="caption" color="text.secondary">
                {online ? 'Online' : 'Offline'}
            </Typography>
        </Box>
    );
}
