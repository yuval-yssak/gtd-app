import { Link } from '@tanstack/react-router';
import { ConnectClaude } from '../components/settings/ConnectClaude';
import { Card, Text } from '../designSystem';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { APP_NAME } from '../lib/appName';
import {
    CLAUDE_GUIDE_ACCESS_NOTES,
    CLAUDE_GUIDE_CAPABILITIES,
    CLAUDE_GUIDE_EXAMPLES,
    CLAUDE_GUIDE_INTRO,
    CLAUDE_GUIDE_NAV_LABEL,
    CLAUDE_GUIDE_SAFETY_NOTE,
    CLAUDE_GUIDE_TITLE,
    CLAUDE_GUIDE_TROUBLESHOOTING,
} from '../lib/claudeGuideContent';
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import styles from './-claudeGuide.module.css';

/**
 * Public documentation for the Claude connector — no session, no AppDataProvider, so it renders for
 * a signed-out reader (Anthropic's directory reviewers among them). The setup steps are the same component Settings shows.
 */
export function ClaudeGuidePage() {
    useDocumentTitle(CLAUDE_GUIDE_NAV_LABEL);
    return (
        <main className={styles.page} data-testid="claudeGuidePage">
            <Card padding="none" className={styles.card}>
                <nav className={styles.nav} aria-label="Site pages">
                    <Link to="/" data-testid="claudeGuideHomeLink">
                        Home
                    </Link>
                    <Link to="/login" data-testid="claudeGuideSignInLink">
                        Sign in
                    </Link>
                    <Link to={LEGAL_DOCUMENTS.privacy.path}>{LEGAL_DOCUMENTS.privacy.title}</Link>
                    <Link to={LEGAL_DOCUMENTS.terms.path}>{LEGAL_DOCUMENTS.terms.title}</Link>
                </nav>
                <Text as="h1" variant="headline" weight="semibold" className={styles.title} data-testid="claudeGuideTitle">
                    {CLAUDE_GUIDE_TITLE}
                </Text>
                <Text as="p" className={styles.intro}>
                    {CLAUDE_GUIDE_INTRO}
                </Text>
                <SetUp />
                <Examples />
                <Capabilities />
                <DataAccess />
                <Troubleshooting />
            </Card>
        </main>
    );
}

function SetUp() {
    return (
        <section aria-labelledby="claude-guide-setup">
            <Text as="h2" variant="title" id="claude-guide-setup" className={styles.sectionTitle}>
                Set it up
            </Text>
            <Text as="p" className={styles.setupNote}>
                You need a {APP_NAME} account (<Link to="/login">sign in</Link> with Google or GitHub; it is free today) and any Claude plan that allows custom
                connectors. Nothing is installed and no token is copied.
            </Text>
            <ConnectClaude stepHeadingAs="h3" />
        </section>
    );
}

function Examples() {
    return (
        <section aria-labelledby="claude-guide-examples">
            <Text as="h2" variant="title" id="claude-guide-examples" className={styles.sectionTitle}>
                What you can ask
            </Text>
            <dl className={styles.examples} data-testid="claudeGuideExamples">
                {CLAUDE_GUIDE_EXAMPLES.map((example) => (
                    <div key={example.prompt} className={styles.example}>
                        <dt>“{example.prompt}”</dt>
                        <dd>{example.outcome}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

function Capabilities() {
    return (
        <section aria-labelledby="claude-guide-capabilities">
            <Text as="h2" variant="title" id="claude-guide-capabilities" className={styles.sectionTitle}>
                What Claude can do
            </Text>
            <dl className={styles.examples}>
                {CLAUDE_GUIDE_CAPABILITIES.map((capability) => (
                    <div key={capability.area} className={styles.example}>
                        <dt>{capability.area}</dt>
                        <dd>{capability.actions}</dd>
                    </div>
                ))}
            </dl>
            <Text as="p">{CLAUDE_GUIDE_SAFETY_NOTE}</Text>
        </section>
    );
}

function DataAccess() {
    return (
        <section aria-labelledby="claude-guide-data">
            <Text as="h2" variant="title" id="claude-guide-data" className={styles.sectionTitle}>
                Your data
            </Text>
            <ul className={styles.notes}>
                {CLAUDE_GUIDE_ACCESS_NOTES.map((note) => (
                    <li key={note}>{note}</li>
                ))}
            </ul>
            <Text as="p">
                The <Link to={LEGAL_DOCUMENTS.privacy.path}>{LEGAL_DOCUMENTS.privacy.title}</Link> covers what the service stores and for how long.
            </Text>
        </section>
    );
}

function Troubleshooting() {
    return (
        <section aria-labelledby="claude-guide-troubleshooting">
            <Text as="h2" variant="title" id="claude-guide-troubleshooting" className={styles.sectionTitle}>
                Troubleshooting
            </Text>
            <dl className={styles.examples} data-testid="claudeGuideTroubleshooting">
                {CLAUDE_GUIDE_TROUBLESHOOTING.map((entry) => (
                    <div key={entry.problem} className={styles.example}>
                        <dt>{entry.problem}</dt>
                        <dd>{entry.answer}</dd>
                    </div>
                ))}
            </dl>
            <Text as="p">
                Still stuck? Write to{' '}
                <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} data-testid="claudeGuideContactLink">
                    {LEGAL_CONTACT_EMAIL}
                </a>
                .
            </Text>
        </section>
    );
}
