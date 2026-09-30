import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Link } from '@tanstack/react-router';
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
 * Spacing and font weight on Typography elements go through `sx`: the variant's own emotion class
 * (margin reset, font-weight) outranks a CSS-module class at runtime, so those rules in
 * -landing.module.css would be silently dropped. The module keeps layout, colour and max-width.
 *
 * Public homepage for signed-out visitors of `/` — the URL the Google OAuth branding config names.
 * Google's verification failed once with "your homepage is behind a login page", so this must
 * render without a session and say what the app does and why it asks for Google data.
 */
export function LandingPage() {
    return (
        <main className={styles.page} data-testid="landingPage">
            <Paper elevation={3} className={styles.card}>
                <header className={styles.hero}>
                    <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
                        {APP_NAME}
                    </Typography>
                    <Typography variant="h6" component="p" className={styles.tagline} sx={{ fontWeight: 400 }} data-testid="landingTagline">
                        {LANDING_TAGLINE}
                    </Typography>
                    <Button variant="contained" size="large" component={Link} to="/login" data-testid="landingSignIn">
                        Sign in
                    </Button>
                    <Typography variant="body2" className={styles.muted}>
                        Sign in with Google or GitHub. Free today.
                    </Typography>
                </header>

                <section aria-labelledby="landing-what">
                    <Typography variant="h5" component="h2" id="landing-what" sx={{ fontWeight: 600, mb: 2 }}>
                        What it does
                    </Typography>
                    <dl className={styles.features}>
                        {LANDING_FEATURES.map((feature) => (
                            <div key={feature.title} className={styles.feature}>
                                <dt>{feature.title}</dt>
                                <dd>{feature.body}</dd>
                            </div>
                        ))}
                    </dl>
                    <Typography variant="body1">{LANDING_OPTIONALITY_NOTE}</Typography>
                </section>

                <section aria-labelledby="landing-google" data-testid="landingGoogleDataUse">
                    <Typography variant="h5" component="h2" id="landing-google" sx={{ fontWeight: 600, mb: 2 }}>
                        How {APP_NAME} uses your Google data
                    </Typography>
                    <Typography variant="body1">{GOOGLE_SIGN_IN_DATA_USE}</Typography>
                    <Typography variant="body1" sx={{ mt: 2 }}>
                        If you connect Google Calendar, {APP_NAME} asks for these permissions:
                    </Typography>
                    <ul className={styles.scopes}>
                        {GOOGLE_CALENDAR_DATA_USES.map((dataUse) => (
                            <li key={dataUse.scope}>
                                <code>{dataUse.scope}</code>
                                <span>{dataUse.purpose}</span>
                            </li>
                        ))}
                    </ul>
                    <Typography variant="body1" sx={{ mt: 2 }} data-testid="landingLimitedUse">
                        {GOOGLE_LIMITED_USE_STATEMENT} Full details are in the{' '}
                        <Link to={LEGAL_DOCUMENTS.privacy.path} hash={GOOGLE_DISCLOSURE_ANCHOR}>
                            Google API Services disclosure
                        </Link>{' '}
                        of the privacy policy.
                    </Typography>
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
                    <Typography variant="caption" component="p" className={styles.trademark} sx={{ mt: 2 }} data-testid="landingTrademarkNotice">
                        {LANDING_TRADEMARK_NOTICE}
                    </Typography>
                </footer>
            </Paper>
        </main>
    );
}
