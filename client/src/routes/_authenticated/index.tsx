import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/')({
    beforeLoad: () => {
        // Inbox is the GTD entry point — redirect immediately
        throw redirect({ to: '/inbox' });
    },
    component: () => null,
});
