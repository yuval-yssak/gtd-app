import { createFileRoute } from '@tanstack/react-router';
import { ClaudeGuidePage } from './-ClaudeGuidePage';

export const Route = createFileRoute('/claude')({
    component: ClaudeGuidePage,
});
