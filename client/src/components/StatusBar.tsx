import CircleIcon from '@mui/icons-material/Circle';
import Typography from '@mui/material/Typography';
import { useOnline } from '../hooks/useOnline';
import styles from './StatusBar.module.css';

export function StatusBar() {
    const online = useOnline();

    return (
        <div className={styles.root}>
            <CircleIcon className={online ? styles.dotOnline : styles.dotOffline} />
            <Typography variant="caption" color="text.secondary">
                {online ? 'Online' : 'Offline'}
            </Typography>
        </div>
    );
}
