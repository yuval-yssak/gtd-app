import { useState } from 'react';
import { Toast } from '../../designSystem';

interface StageNotice {
    message: string;
    tone: 'neutral' | 'error';
}

/**
 * A review stage's transient message. Failures raise `showError` so the toast is announced as an
 * alert; everything else (e.g. the Gmail read-only warning) stays a polite status.
 */
export function useStageToast() {
    const [notice, setNotice] = useState<StageNotice | null>(null);
    return {
        showNotice: (message: string) => setNotice({ message, tone: 'neutral' }),
        showError: (message: string) => setNotice({ message, tone: 'error' }),
        toastProps: { notice, onDismissed: () => setNotice(null) },
    };
}

interface StageToastProps {
    notice: StageNotice | null;
    onDismissed: () => void;
}

export function StageToast({ notice, onDismissed }: StageToastProps) {
    return <Toast open={notice !== null} message={notice?.message} tone={notice?.tone} autoHideDuration={3000} onClose={onDismissed} />;
}
