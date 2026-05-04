import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Mode = 'page' | 'inline';

interface Props {
    children: ReactNode;
    mode?: Mode;
    /** Override copy for the error title. */
    title?: string;
    /**
     * If provided, rendered in place of the built-in retry button. Lets nested boundaries opt out
     * of "reload the page" — for example, a per-dialog boundary that should just close the dialog.
     */
    fallbackAction?: (reset: () => void) => ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Class component because that's still the only React API that catches render-phase + Suspense
 * errors thrown by descendants. Two visual modes: 'page' for top-level boundaries (full reload),
 * 'inline' for nested boundaries that should fit inside an existing layout.
 */
export class AppErrorBoundary extends Component<Props, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[AppErrorBoundary] caught', error, info.componentStack);
    }

    private reset = () => this.setState({ error: null });

    private renderAction(mode: Mode, fallbackAction: Props['fallbackAction']) {
        if (fallbackAction) {
            return fallbackAction(this.reset);
        }
        if (mode === 'page') {
            return (
                <Button onClick={() => window.location.reload()} variant="contained" data-testid="errorBoundaryReload">
                    Reload
                </Button>
            );
        }
        return (
            <Button onClick={this.reset} variant="outlined" data-testid="errorBoundaryRetry">
                Retry
            </Button>
        );
    }

    override render() {
        if (!this.state.error) {
            return this.props.children;
        }
        const { mode = 'page', title = 'Something went wrong', fallbackAction } = this.props;
        return (
            <Box
                data-testid={mode === 'page' ? 'pageErrorBoundary' : 'inlineErrorBoundary'}
                sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: mode === 'page' ? 'center' : 'flex-start',
                    minHeight: mode === 'page' ? '100dvh' : 'auto',
                    p: mode === 'page' ? 4 : 2,
                }}
            >
                <Alert severity="error" action={this.renderAction(mode, fallbackAction)} sx={{ maxWidth: 480, width: '100%' }}>
                    <AlertTitle>{title}</AlertTitle>
                    {this.state.error.message}
                </Alert>
            </Box>
        );
    }
}
