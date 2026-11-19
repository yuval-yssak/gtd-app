import type { Meta, StoryObj } from '@storybook/react';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import { ClaudeGuidePage } from './-ClaudeGuidePage';
import { LandingPage } from './-LandingPage';
import { LegalPage } from './-LegalPage';

const meta = {
    title: 'Pages/Public',
    component: LandingPage,
    parameters: { layout: 'fullscreen' },
    decorators: [RouterDecorator],
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The signed-out homepage Google's OAuth verification reviews. */
export const Landing: Story = {};

/** The public documentation page Anthropic's connector directory links. */
export const ClaudeGuide: StoryObj = { render: () => <ClaudeGuidePage /> };

export const PrivacyPolicy: StoryObj = { render: () => <LegalPage legalDocument={LEGAL_DOCUMENTS.privacy} /> };

export const TermsOfService: StoryObj = { render: () => <LegalPage legalDocument={LEGAL_DOCUMENTS.terms} /> };
