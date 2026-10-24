import { describe, expect, it } from 'vitest';
import { chipAppearanceFor } from '../components/itemEditor/MeetingDetails';

// The attendee chip reads its RSVP at a glance: a tinted chip per decision, a neutral outline for
// "no answer yet" so it never looks like a deliberate response.
describe('chipAppearanceFor', () => {
    it('tints each decision in its tone', () => {
        expect(chipAppearanceFor('accepted')).toEqual({ tone: 'success', variant: 'soft' });
        expect(chipAppearanceFor('declined')).toEqual({ tone: 'error', variant: 'soft' });
        expect(chipAppearanceFor('tentative')).toEqual({ tone: 'warning', variant: 'soft' });
    });

    it('outlines a pending response in neutral', () => {
        expect(chipAppearanceFor('needsAction')).toEqual({ tone: 'neutral', variant: 'outline' });
    });
});
