import CircleIcon from '@mui/icons-material/Circle';
import Typography from '@mui/material/Typography';
import { useOnline } from '../hooks/useOnline';
import styles from './StatusBar.module.css';
import { SyncIssuesPanel } from './SyncIssuesPanel';

export function StatusBar() {
    const online = useOnline();

    return (
        <div className={styles.root}>
            <CircleIcon className={online ? styles.dotOnline : styles.dotOffline} />
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                }}
            >
                {online ? 'Online' : 'Offline'}
            </Typography>
            {/* Panel mounts unconditionally — the badge self-suppresses (returns null) when there are
                no failed ops, so an empty state has zero visual footprint. */}
            <SyncIssuesPanel />
        </div>
    );
}
