import { type ReactNode, useId } from 'react';
import { Card, Separator, Text } from '../../designSystem';
import styles from './SettingsSection.module.css';

interface SettingsSectionProps {
    title: string;
    /** The grey line under the title. */
    description?: ReactNode | undefined;
    /** Rules a separator between the description and the section's controls. */
    isDivided?: boolean | undefined;
    children?: ReactNode | undefined;
}

/** One settings card: a named region with a heading, an optional description, then the section's own controls. */
export function SettingsSection({ title, description, isDivided = false, children }: SettingsSectionProps) {
    const headingId = useId();
    return (
        <Card padding="none" className={styles.section}>
            <section className={styles.content} aria-labelledby={headingId}>
                <Text variant="subtitle" weight="semibold" id={headingId} className={styles.heading}>
                    {title}
                </Text>
                {description !== undefined && (
                    <Text variant="bodySm" tone="secondary" className={styles.description}>
                        {description}
                    </Text>
                )}
                {isDivided && <Separator className={styles.divider} />}
                {children}
            </section>
        </Card>
    );
}
