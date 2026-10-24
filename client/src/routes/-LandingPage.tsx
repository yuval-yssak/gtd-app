import { Link } from '@tanstack/react-router';
import { ButtonLink, Card, Text } from '../designSystem';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { APP_NAME } from '../lib/appName';
import {
    GOOGLE_CALENDAR_DATA_USES,
    GOOGLE_LIMITED_USE_STATEMENT,
    GOOGLE_SIGN_IN_DATA_USE,
    LANDING_FEATURES,
    LANDING_OPTIONALITY_NOTE,
    LANDING_TAGLINE,
    LANDING_TRADEMARK_NOTICE,
} from '../lib/landingContent';
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, legalSectionAnchor } from '../lib/legalDocuments';
import styles from './-landing.module.css';

const GOOGLE_DISCLOSURE_ANCHOR = legalSectionAnchor('Google API Services disclosure');

/**
 * Public homepage for signed-out visitors of `/` — the URL the Google OAuth branding config names.
 * Google's verification failed once with "your homepage is behind a login page", so this must
 * render without a session and say what the app does and why it asks for Google data.
 */
export function LandingPage() {
    useDocumentTitle(undefined);
    return (
        <main className={styles.page} data-testid="landingPage">
            <Card padding="none" className={styles.card}>
                <header className={styles.hero}>
                    <Text as="h1" variant="display" weight="bold">
                        {APP_NAME}
                    </Text>
                    <Text as="p" variant="titleSm" weight="regular" className={styles.tagline} data-testid="landingTagline">
                        {LANDING_TAGLINE}
                    </Text>
                    <ButtonLink variant="solid" size="lg" render={<Link to="/login" />} data-testid="landingSignIn">
                        Sign in
                    </ButtonLink>
                    <Text variant="bodySm" tone="secondary">
                        Sign in with Google or GitHub. Free today.
                    </Text>
                </header>

                <section aria-labelledby="landing-what">
                    <Text as="h2" variant="title" id="landing-what" className={styles.sectionTitle}>
                        What it does
                    </Text>
                    <dl className={styles.features}>
                        {LANDING_FEATURES.map((feature) => (
                            <div key={feature.title} className={styles.feature}>
                                <dt>{feature.title}</dt>
                                <dd>{feature.body}</dd>
                            </div>
                        ))}
                    </dl>
                    <Text>{LANDING_OPTIONALITY_NOTE}</Text>
                </section>

                <section aria-labelledby="landing-google" data-testid="landingGoogleDataUse">
                    <Text as="h2" variant="title" id="landing-google" className={styles.sectionTitle}>
                        How {APP_NAME} uses your Google data
                    </Text>
                    <Text>{GOOGLE_SIGN_IN_DATA_USE}</Text>
                    <Text className={styles.followingParagraph}>If you connect Google Calendar, {APP_NAME} asks for these permissions:</Text>
                    <ul className={styles.scopes}>
                        {GOOGLE_CALENDAR_DATA_USES.map((dataUse) => (
                            <li key={dataUse.scope}>
                                <code>{dataUse.scope}</code>
                                <span>{dataUse.purpose}</span>
                            </li>
                        ))}
                    </ul>
                    <Text className={styles.followingParagraph} data-testid="landingLimitedUse">
                        {GOOGLE_LIMITED_USE_STATEMENT} Full details are in the{' '}
                        <Link to={LEGAL_DOCUMENTS.privacy.path} hash={GOOGLE_DISCLOSURE_ANCHOR}>
                            Google API Services disclosure
                        </Link>{' '}
                        of the privacy policy.
                    </Text>
                </section>

                <footer className={styles.footer}>
                    <nav aria-label="Legal pages" className={styles.footerNav}>
                        <Link to={LEGAL_DOCUMENTS.privacy.path} data-testid="landingPrivacyLink">
                            {LEGAL_DOCUMENTS.privacy.title}
                        </Link>
                        <Link to={LEGAL_DOCUMENTS.terms.path} data-testid="landingTermsLink">
                            {LEGAL_DOCUMENTS.terms.title}
                        </Link>
                        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>Contact</a>
                    </nav>
                    <Text as="p" variant="caption" tone="secondary" className={styles.trademark} data-testid="landingTrademarkNotice">
                        {LANDING_TRADEMARK_NOTICE}
                    </Text>
                </footer>
            </Card>
        </main>
    );
}
