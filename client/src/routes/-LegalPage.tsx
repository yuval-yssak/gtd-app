import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Link } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { MarkdownPreview } from '../components/markdown/MarkdownPreview';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, type LegalDocument, legalSectionAnchor, legalSectionHeadings } from '../lib/legalDocuments';
import styles from './-legal.module.css';

/**
 * Public page shell shared by /privacy and /terms — no session, no AppDataProvider, so it renders
 * for signed-out visitors (Google's OAuth verification reviewers among them). The other document
 * and the sign-in page are linked at the top; the body is the Markdown from `lib/legalDocuments`.
 */
export function LegalPage({ legalDocument }: { legalDocument: LegalDocument }) {
    const otherDocument = legalDocument.slug === 'privacy' ? LEGAL_DOCUMENTS.terms : LEGAL_DOCUMENTS.privacy;
    const headings = legalSectionHeadings(legalDocument.markdown);
    return (
        <main className={styles.page} data-testid="legalPage">
            <Paper elevation={3} className={styles.card}>
                <nav className={styles.nav} aria-label="Legal pages">
                    <Link to="/login">Sign in</Link>
                    <Link to={otherDocument.path}>{otherDocument.title}</Link>
                </nav>
                <Typography variant="h4" component="h1" className={styles.title} data-testid="legalTitle">
                    {legalDocument.title}
                </Typography>
                <Typography variant="body2" className={styles.effectiveDate}>
                    Effective {dayjs(LEGAL_EFFECTIVE_DATE).format('D MMMM YYYY')}
                </Typography>
                <nav aria-label="Contents">
                    <ol className={styles.contents}>
                        {headings.map((heading) => (
                            <li key={heading}>
                                <a href={`#${legalSectionAnchor(heading)}`}>{heading}</a>
                            </li>
                        ))}
                    </ol>
                </nav>
                <MarkdownPreview markdown={legalDocument.markdown} headingId={legalSectionAnchor} internalLinksInSameTab />
            </Paper>
        </main>
    );
}
