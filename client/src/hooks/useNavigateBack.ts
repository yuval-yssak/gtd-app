import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';

/**
 * Back-navigation for detail pages: real history-back when the user navigated here
 * in-app — it returns to the exact previous location (search params included), which
 * is also the key the source list's scroll restoration saved under. The fallback
 * route covers deep links with no in-app history entry.
 */
export function useNavigateBack() {
    const navigate = useNavigate();
    const router = useRouter();
    const canGoBack = useCanGoBack();
    return (fallbackTo: string) => {
        if (canGoBack) {
            router.history.back();
        } else {
            void navigate({ to: fallbackTo });
        }
    };
}
