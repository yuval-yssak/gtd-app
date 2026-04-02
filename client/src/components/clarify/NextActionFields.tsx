import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { EnergyLevel, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './NextActionFields.module.css';
import type { NextActionFormState } from './types';

interface Props {
    value: NextActionFormState;
    onChange: (patch: Partial<NextActionFormState>) => void;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
}

export function NextActionFields({ value, onChange, workContexts, people }: Props) {
    function toggleWorkContext(id: string) {
        const ids = value.workContextIds.includes(id) ? value.workContextIds.filter((x) => x !== id) : [...value.workContextIds, id];
        onChange({ workContextIds: ids });
    }

    function togglePerson(id: string) {
        const ids = value.peopleIds.includes(id) ? value.peopleIds.filter((x) => x !== id) : [...value.peopleIds, id];
        onChange({ peopleIds: ids });
    }

    return (
        <Stack gap={2}>
            {/* Tickler field shown first — "ignoreBefore" hides the item until that date.
                Placing it at the top makes the snooze intent explicit before filling other fields. */}
            <Box>
                <FormLabel>
                    <Typography variant="caption" color="text.secondary">
                        Tickler — hide until
                    </Typography>
                </FormLabel>
                <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                    Item stays hidden from Next Actions until this date
                </Typography>
                <TextField
                    type="date"
                    value={value.ignoreBefore}
                    onChange={(e) => onChange({ ignoreBefore: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
            </Box>

            {workContexts.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary">
                            Work contexts
                        </Typography>
                    </FormLabel>
                    <Stack direction="row" flexWrap="wrap" gap={0.75} mt={0.5}>
                        {workContexts.map((ctx) => (
                            <Chip
                                key={ctx._id}
                                label={ctx.name}
                                size="small"
                                variant={value.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                color={value.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                onClick={() => toggleWorkContext(ctx._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}

            {people.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary">
                            People
                        </Typography>
                    </FormLabel>
                    <Stack direction="row" flexWrap="wrap" gap={0.75} mt={0.5}>
                        {people.map((p) => (
                            <Chip
                                key={p._id}
                                label={p.name}
                                size="small"
                                variant={value.peopleIds.includes(p._id) ? 'filled' : 'outlined'}
                                color={value.peopleIds.includes(p._id) ? 'primary' : 'default'}
                                onClick={() => togglePerson(p._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}

            <Box>
                <FormLabel>
                    <Typography variant="caption" color="text.secondary">
                        Energy
                    </Typography>
                </FormLabel>
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={value.energy || null}
                    onChange={(_e, val: EnergyLevel | null) => onChange({ energy: val ?? '' })}
                    className={styles.energyToggle}
                >
                    <ToggleButton value="low">Low</ToggleButton>
                    <ToggleButton value="medium">Medium</ToggleButton>
                    <ToggleButton value="high">High</ToggleButton>
                </ToggleButtonGroup>
            </Box>

            <TextField
                label="Time estimate (min)"
                value={value.time}
                onChange={(e) => onChange({ time: e.target.value })}
                type="number"
                size="small"
                className={styles.timeField}
                slotProps={{ htmlInput: { min: 1 } }}
            />

            <Stack direction="row" gap={2}>
                <FormControlLabel
                    control={<Checkbox size="small" checked={value.urgent} onChange={(e) => onChange({ urgent: e.target.checked })} />}
                    label={<Typography variant="body2">Urgent</Typography>}
                />
                <FormControlLabel
                    control={<Checkbox size="small" checked={value.focus} onChange={(e) => onChange({ focus: e.target.checked })} />}
                    label={<Typography variant="body2">Needs focus</Typography>}
                />
            </Stack>

            <TextField
                label="Expected by"
                type="date"
                value={value.expectedBy}
                onChange={(e) => onChange({ expectedBy: e.target.value })}
                size="small"
                slotProps={{ inputLabel: { shrink: true } }}
            />
        </Stack>
    );
}
