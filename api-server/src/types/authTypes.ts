import type { Auth } from '../auth/betterAuth.js';

export type Session = Auth['$Infer']['Session'];
export type AuthVariables = { session: Session };
