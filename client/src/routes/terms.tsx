import { createFileRoute } from '@tanstack/react-router';
import { LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import { LegalPage } from './-LegalPage';

export const Route = createFileRoute('/terms')({
    component: () => <LegalPage legalDocument={LEGAL_DOCUMENTS.terms} />,
});
