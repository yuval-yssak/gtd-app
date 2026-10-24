import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Callout } from '../designSystem';
import styles from './AppErrorBoundary.module.css';

type Mode = 'page' | 'inline';

interface Props {
    children: ReactNode;
    mode?: Mode | undefined;
    /** Override copy for the error title. */
    title?: string | undefined;
    /**
     * If provided, rendered in place of the built-in retry button. Lets nested boundaries opt out
     * of "reload the page" — for example, a per-dialog boundary that should just close the dialog.
     */
    fallbackAction?: ((reset: () => void) => ReactNode) | undefined;
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
                <Button onClick={() => window.location.reload()} variant="solid" tone="danger" size="sm" data-testid="errorBoundaryReload">
                    Reload
                </Button>
            );
        }
        return (
            <Button onClick={this.reset} variant="outline" tone="danger" size="sm" data-testid="errorBoundaryRetry">
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
            <div data-testid={mode === 'page' ? 'pageErrorBoundary' : 'inlineErrorBoundary'} data-mode={mode} className={styles.root}>
                <Callout tone="error" title={title} action={this.renderAction(mode, fallbackAction)} className={styles.callout}>
                    {this.state.error.message}
                </Callout>
            </div>
        );
    }
}
