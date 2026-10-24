import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '../Button/Button';
import { ButtonGroup } from '../ButtonGroup/ButtonGroup';
import { Collapsible } from '../Collapsible/Collapsible';
import { ToggleGroup } from '../ToggleGroup/ToggleGroup';
import { Tabs } from './Tabs';

function Segmented({ startExpanded = false }: { startExpanded?: boolean }) {
    const [tab, setTab] = useState<'nextAction' | 'calendar'>('nextAction');
    const [ends, setEnds] = useState<'never' | 'on' | 'after'>('never');
    const [isExpanded, setIsExpanded] = useState(startExpanded);
    return (
        <div style={{ display: 'grid', gap: '1.5rem', minInlineSize: '24rem' }}>
            <Tabs
                aria-label="Routine type"
                value={tab}
                onValueChange={setTab}
                tabs={[
                    { value: 'nextAction', label: 'Next Action (4)' },
                    { value: 'calendar', label: 'Calendar (2)' },
                ]}
            />
            <ToggleGroup
                aria-label="Ends"
                value={ends}
                onValueChange={setEnds}
                options={[
                    { value: 'never', label: 'Never' },
                    { value: 'on', label: 'On date' },
                    { value: 'after', label: 'After' },
                ]}
            />
            <ButtonGroup aria-label="Position">
                <Button variant="outline" title="Move to top (Shift+Home)">
                    Top
                </Button>
                <Button variant="outline" title="Move up (Shift+↑)">
                    Up
                </Button>
                <Button variant="outline" title="Move down (Shift+↓)">
                    Down
                </Button>
            </ButtonGroup>
            <div>
                <Button onClick={() => setIsExpanded((current) => !current)}>{isExpanded ? 'Hide' : 'Show'} details</Button>
                <Collapsible open={isExpanded}>
                    <p>Collapsible content that animates its height.</p>
                </Collapsible>
            </div>
        </div>
    );
}

const meta = {
    title: 'Design System/Segmented',
    component: Segmented,
} satisfies Meta<typeof Segmented>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Expanded: Story = { args: { startExpanded: true } };
