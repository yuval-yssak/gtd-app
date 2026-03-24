import CircleIcon from '@mui/icons-material/Circle';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

export function StatusBar() {
    const [online, setOnline] = useState(navigator.onLine);

    useEffect(() => {
        const handleOnline = () => setOnline(true);
        const handleOffline = () => setOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

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
