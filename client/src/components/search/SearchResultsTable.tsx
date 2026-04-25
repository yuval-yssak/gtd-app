import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useState } from 'react';
import { itemContextNames, itemPersonNames } from '../../lib/itemSearch';
import { SEARCH_TABLE_COLUMNS, type SearchTableColumnId } from '../../lib/searchTableColumns';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './SearchResultsTable.module.css';
import { StatusChip } from './StatusChip';

interface Props {
    items: readonly StoredItem[];
    visibleColumns: ReadonlySet<SearchTableColumnId>;
    onVisibleColumnsChange: (next: Set<SearchTableColumnId>) => void;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
}

const formatDate = (iso: string | undefined) => (iso ? dayjs(iso).format('MMM D, YYYY') : '—');

const formatDateOnly = (iso: string | undefined) => (iso ? dayjs(iso).format('MMM D, YYYY') : '—');

function ColumnPicker({ visibleColumns, onChange }: { visibleColumns: ReadonlySet<SearchTableColumnId>; onChange: (next: Set<SearchTableColumnId>) => void }) {
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

    const togglePicker = (id: SearchTableColumnId) => {
        const next = new Set(visibleColumns);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        onChange(next);
    };

    return (
        <>
            <Button
                size="small"
                startIcon={<ViewColumnIcon />}
                variant="outlined"
                onClick={(e) => setAnchorEl(e.currentTarget)}
                className={styles.columnsButton}
            >
                Columns
            </Button>
            <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => setAnchorEl(null)}>
                {SEARCH_TABLE_COLUMNS.map((col) => (
                    <MenuItem key={col.id} onClick={() => !col.fixed && togglePicker(col.id)} disabled={col.fixed === true}>
                        <FormControlLabel
                            control={<Checkbox size="small" checked={visibleColumns.has(col.id)} disabled={col.fixed === true} />}
                            label={col.label}
                            // Stop the click reaching the MenuItem when the checkbox itself is clicked,
                            // otherwise the toggle fires twice (once on the checkbox, once on the row).
                            onClick={(e) => e.stopPropagation()}
                        />
                    </MenuItem>
                ))}
            </Menu>
        </>
    );
}

function ResultCell({
    column,
    item,
    peopleById,
    contextsById,
}: {
    column: SearchTableColumnId;
    item: StoredItem;
    peopleById: Map<string, StoredPerson>;
    contextsById: Map<string, StoredWorkContext>;
}) {
    if (column === 'title') return <span className={styles.titleCell}>{item.title}</span>;
    if (column === 'status') return <StatusChip status={item.status} />;
    if (column === 'updated') return <span>{formatDate(item.updatedTs)}</span>;
    if (column === 'created') return <span>{formatDate(item.createdTs)}</span>;
    if (column === 'expectedBy') return <span>{formatDateOnly(item.expectedBy)}</span>;
    if (column === 'people') {
        const names = itemPersonNames(item, peopleById);
        return <span>{names.length > 0 ? names.join(', ') : '—'}</span>;
    }
    // contexts
    const names = itemContextNames(item, contextsById);
    return <span>{names.length > 0 ? names.join(', ') : '—'}</span>;
}

export function SearchResultsTable({ items, visibleColumns, onVisibleColumnsChange, people, workContexts }: Props) {
    const navigate = useNavigate();
    const peopleById = new Map(people.map((p) => [p._id, p]));
    const contextsById = new Map(workContexts.map((c) => [c._id, c]));
    const orderedColumns = SEARCH_TABLE_COLUMNS.filter((c) => visibleColumns.has(c.id));

    return (
        <>
            <div className={styles.toolbar}>
                <ColumnPicker visibleColumns={visibleColumns} onChange={onVisibleColumnsChange} />
            </div>
            <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            {orderedColumns.map((col) => (
                                <TableCell key={col.id}>{col.label}</TableCell>
                            ))}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {items.map((item) => (
                            <TableRow
                                key={item._id}
                                hover
                                onClick={() => void navigate({ to: '/item/$itemId', params: { itemId: item._id }, search: { dest: null } })}
                                className={styles.row}
                            >
                                {orderedColumns.map((col) => (
                                    <TableCell key={col.id}>
                                        <ResultCell column={col.id} item={item} peopleById={peopleById} contextsById={contextsById} />
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </>
    );
}
