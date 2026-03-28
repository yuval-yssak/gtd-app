import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { createFileRoute } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { getItemsByUser } from '../../db/itemHelpers';
import { clarifyToDone } from '../../db/itemMutations';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { usePeople } from '../../hooks/usePeople';
import type { StoredItem } from '../../types/MyDB';
import styles from './waiting-for.module.css';

export const Route = createFileRoute('/_authenticated/waiting-for')({
    component: WaitingForPage,
});

function WaitingForPage() {
    const { db, items, setItems } = Route.useRouteContext();
    const account = useActiveAccount(db);
    const people = usePeople(db, account?.id ?? null);

    const waitingItems = items.filter((item) => item.status === 'waitingFor').sort((a, b) => (a.expectedBy ?? '').localeCompare(b.expectedBy ?? ''));

    const personMap = Object.fromEntries(people.map((p) => [p._id, p.name]));

    // Group by person (or "Unassigned")
    const groups = waitingItems.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.waitingForPersonId ?? '__none__';
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});

    async function onReceived(item: StoredItem) {
        await clarifyToDone(db, item);
        if (!account) return;
        setItems(await getItemsByUser(db, account.id));
    }

    const isOverdue = (item: StoredItem) => item.expectedBy !== undefined && item.expectedBy < dayjs().format('YYYY-MM-DD');

    if (waitingItems.length === 0) {
        return (
            <Box>
                <Typography variant="h5" fontWeight={600} mb={3}>
                    Waiting For
                </Typography>
                <Typography color="text.secondary" textAlign="center" mt={6}>
                    Nothing pending.
                </Typography>
            </Box>
        );
    }

    return (
        <Box>
            <Typography variant="h5" fontWeight={600} mb={3}>
                Waiting For
                <Chip label={waitingItems.length} size="small" color="primary" sx={{ ml: 1.5, verticalAlign: 'middle' }} />
            </Typography>
            {Object.entries(groups).map(([personId, groupItems]) => (
                <Box key={personId} mb={3}>
                    <Typography variant="subtitle2" color="text.secondary" fontWeight={600} mb={1}>
                        {personId === '__none__' ? 'Unassigned' : (personMap[personId] ?? 'Unknown')}
                    </Typography>
                    <List disablePadding className={styles.list}>
                        {groupItems.map((item, idx) => (
                            <Box key={item._id}>
                                <ListItem
                                    disablePadding
                                    className={styles.item}
                                    secondaryAction={
                                        <Tooltip title="Received">
                                            <IconButton size="small" color="success" onClick={() => void onReceived(item)}>
                                                <CheckCircleOutlineIcon />
                                            </IconButton>
                                        </Tooltip>
                                    }
                                >
                                    <ListItemText
                                        primary={item.title}
                                        secondary={
                                            item.expectedBy ? (
                                                <Typography component="span" variant="caption" color={isOverdue(item) ? 'error' : 'text.secondary'}>
                                                    Expected by {dayjs(item.expectedBy).format('MMM D')}
                                                    {isOverdue(item) && ' — overdue'}
                                                </Typography>
                                            ) : undefined
                                        }
                                        sx={{ pr: 6 }}
                                    />
                                </ListItem>
                                {idx < groupItems.length - 1 && <Divider />}
                            </Box>
                        ))}
                    </List>
                </Box>
            ))}
        </Box>
    );
}
