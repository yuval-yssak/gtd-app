import { clsx } from 'clsx';
import type { ComponentProps } from 'react';
import styles from './Skeleton.module.css';

type SkeletonProps = Omit<ComponentProps<'span'>, 'children'> & {
    /** text = one line of body text, rect = a block, circle = an avatar. */
    shape?: 'text' | 'rect' | 'circle' | undefined;
};

/** Loading placeholder (MUI Skeleton). Size it from the caller's module class. Hidden from AT. */
export function Skeleton({ shape = 'text', className, ...rest }: SkeletonProps) {
    return <span aria-hidden="true" data-shape={shape} {...rest} className={clsx(styles.skeleton, className)} />;
}
