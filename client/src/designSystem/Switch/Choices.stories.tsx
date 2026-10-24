import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Checkbox } from '../Checkbox/Checkbox';
import { RadioGroup } from '../RadioGroup/RadioGroup';
import { Switch } from './Switch';

function Choices({ disabled = false }: { disabled?: boolean }) {
    const [isOn, setIsOn] = useState(true);
    const [isChecked, setIsChecked] = useState(false);
    const [mode, setMode] = useState<'system' | 'light' | 'dark'>('system');
    return (
        <div style={{ display: 'grid', gap: '1rem' }}>
            <Switch checked={isOn} onCheckedChange={setIsOn} label="Show briefs" description="One-line summaries in the weekly review" disabled={disabled} />
            <Switch checked={!isOn} onCheckedChange={(next) => setIsOn(!next)} label="Placed at the end" placement="end" disabled={disabled} />
            <Checkbox checked={isChecked} onCheckedChange={setIsChecked} label="Sync Primary" disabled={disabled} />
            <Checkbox checked onCheckedChange={() => {}} label="Indeterminate" indeterminate disabled={disabled} />
            <RadioGroup
                aria-label="Theme"
                value={mode}
                onValueChange={setMode}
                disabled={disabled}
                options={[
                    { value: 'system', label: 'System', description: 'Follow the device setting' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                ]}
            />
        </div>
    );
}

const meta = {
    title: 'Design System/Choices',
    component: Choices,
} satisfies Meta<typeof Choices>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enabled: Story = {};
export const Disabled: Story = { args: { disabled: true } };
