Getting Things Done ("the Service", "we", "us") is a personal productivity app operated by Yuval Yssak, an individual based in Israel. This policy explains what personal data the Service handles, why, where it is stored and who else processes it. It applies to the web app at getting-things-done.app, its public API and the MCP server.

If anything here is unclear, write to [yuval.yssak@gmail.com](mailto:yuval.yssak@gmail.com).

## What we collect

**Account data.** When you sign in with Google or GitHub we receive your name, email address and profile picture URL from that provider, plus the provider's account identifier and the sign-in tokens it issues. Accounts from both providers that share an email address are linked into one user.

**Your content.** Everything you put into the Service: items (titles, notes, dates, energy/time/focus tags), routines, work contexts, weekly-review state, and the people you add — including any name, email address, phone number and notes you record about them. Notes can contain anything you choose to write, so please treat them as you would any private document.

**Calendar data (only if you connect Google Calendar).** With your explicit consent we read and write the calendars you select: event titles, times, descriptions, locations, meeting links, organizer and attendee names, email addresses and RSVP status. We store the OAuth access and refresh tokens Google issues so sync can keep running while you are away; those tokens are encrypted at rest with AES-256-GCM.

**Device and session data.** A random device identifier, a browser label (for example "Chrome on macOS"), an optional name you give the device, your time zone, and — if you enable notifications — the push endpoint your browser vendor assigns. Sign-in sessions record the IP address and user agent that created them.

**Integration data.** Personal API tokens you create (we store only a hash), webhook URLs you register with their signing secret, MCP client registrations, and per-day counts of AI usage.

**Technical logs.** Our servers log requests (route, timing, status code, your user id, IP address and user agent) and internal identifiers to diagnose problems — never the text of your items or calendar events, and never email addresses. Logs are kept by Google Cloud Logging for 30 days.

**Usage metrics.** We may in future record counts and timings of how the Service is used — which screens and features, how often, how many items sit in each state — never the text of your items. See "Product research" below.

We do **not** use third-party analytics, advertising or tracking services, and set no cookies for those purposes.

## How we use it

- To run the Service: store and sync your content between your devices, show it back to you, and keep it available offline.
- To sync with Google Calendar when you connect it: mirror events into the app, push the changes you make back to Google, and mark events done.
- To generate AI features: one-line item briefs (created automatically for open items with longer notes) and the "clarify with AI" assistant (only when you ask for it).
- To send notifications you opt into (web push) and, where we have your address, service messages (for example, when a calendar connection needs to be re-authorised).
- To secure the Service, prevent abuse and enforce our Terms.
- To understand where the Service helps or gets in the way, and to improve it, using usage metrics — see "Product research" below.

We never sell personal data, never use your content for advertising, and never use it to train machine-learning models.

## AI processing

Two features send content to Anthropic, the provider of the Claude models:

- **Item briefs** send an item's status, title and notes; for calendar items this can include an event description imported from Google Calendar. No name, email address or user identifier accompanies them.
- **Clarify with AI** sends the item you are working on (title, notes, status), any instruction you type, and — only when the assistant needs them — the names of your work contexts, the names and email addresses of people in your address book, the first 500 characters of related items, and the titles and times of calendar events.

Anthropic processes this data under its commercial API terms, which do not permit it to train models on API inputs or outputs. Briefs are generated automatically for every open item whose notes are long enough to need one; the "Show briefs" switch in Settings hides them on that device but does not stop generation. The assistant only runs when you ask it to.

## Product research

We want to learn where the Service helps and where it gets in the way. To do that we look at **how** it is used, not **what** you write:

- **Usage metrics.** We may record which screens and features are used and how often, how many items sit in each state and for how long, how often reviews are completed, and similar counts and timings. These metrics never include the text of your items, notes, people or calendar events.
- **Your content is not read.** No one reads your notes or items for research unless you opt in through a "Help improve the product" setting, which we will ask you about explicitly before any review begins. If you opt in, we may review a sample of your content to understand how the Service is used; you can opt out at any time and we stop reviewing from that moment. Data received from Google Calendar is never included in such reviews, even if you opt in.
- **Support, security and legal.** Outside research, a person may look at your content only to answer a support request you raised, to investigate abuse or a security incident, or when the law requires it.
- **No model training.** Your content is never used to train or fine-tune machine-learning models — ours or anyone else's.

## Google API Services disclosure

Getting Things Done's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes), including the Limited Use requirements. Calendar data is used only to provide user-facing features of the app: calendar sync, and — as described under "AI processing" — item briefs for calendar items and the event context the "clarify with AI" assistant uses when you ask it to. It is never used for advertising, never sold, never used to train machine-learning models, and only read by a person with your consent (for example, to answer a support request you raised), for security purposes such as investigating abuse, or when required by law. For product research it is used only in aggregated, anonymised form and is never read by a person.

Disconnecting the calendar in Settings deletes the tokens we hold, which ends our access. To remove the grant from your Google Account as well, use [your Google Account permissions](https://myaccount.google.com/permissions).

## Who else processes your data

| Processor | What they do | Where |
|---|---|---|
| Google Cloud (Cloud Run, Cloud Logging, Cloud Scheduler) | Runs the API server and keeps its logs | United States (us-central1) |
| MongoDB Atlas (on AWS) | Stores the database | United States (us-east-1, N. Virginia) |
| Cloudflare | Serves the web app and proxies API traffic | Global edge network; data is processed in transit only |
| Anthropic | Runs the AI features described above | United States |
| Google | Sign-in, and Google Calendar when you connect it | Per Google's own policies |
| GitHub | Sign-in | Per GitHub's own policies |
| Apple, Google or Mozilla push services | Deliver web push notifications to your browser | Per the vendor of your browser |

Your data is therefore stored and processed in the United States. If you are in the EU/EEA, the UK or Switzerland, this is a transfer outside your region; we rely on the processors' standard contractual clauses and your consent to use the Service.

If we introduce paid features, payment details will be handled by a payment processor rather than by us; we will name it here before the first charge.

## How long we keep it

- **Content, calendar data, devices, integrations:** for as long as your account exists. Items you move to the trash are kept, and can be restored, until the account is deleted; devices inactive for 30 days are removed automatically.
- **Change history:** every edit is kept as a change record until all of your devices have received it, then purged.
- **Sessions:** until 7 days have passed without activity, or until you sign out.
- **Inactive accounts:** an account unused for 12 months may be deleted after we email a 30-day warning (see the Terms); its data is then removed as described below.
- **Webhook delivery records:** each delivery to a webhook you registered keeps a copy of the item as it was sent, for as long as your account exists — deleting the item or person later does not remove it from those records.
- **Service emails:** a record of each service email (recipient, subject and body) is kept for as long as your account exists.
- **Logs:** 30 days.
- **After account deletion:** all of the above is deleted within 30 days. The database has no long-term backups, so deletion is final.

## Your rights

Depending on where you live you may have the right to access, correct, export, restrict or delete your personal data, and to object to certain processing. You can edit any item, move it to the trash, and delete people, routines and devices in the app; disconnect Google Calendar; and revoke API tokens and webhooks. To export your data or delete your account, email [yuval.yssak@gmail.com](mailto:yuval.yssak@gmail.com) from the address on the account; we will act within 30 days. In-app "Download my data" and "Delete my account" controls are on the roadmap.

If you are in the EU/EEA or the UK you may also complain to your local data-protection authority.

## Cookies and on-device storage

- **Cookies.** Signing in sets a session cookie on the API domain (`__Secure-better-auth.session_token`, plus one cookie per additional account you add). They are HTTP-only, secure, expire after 7 days without activity and exist only to keep you signed in. There are no advertising or analytics cookies.
- **On your device.** The app is offline-first: a copy of your content, your pending changes and your account list live in your browser's IndexedDB; display preferences (theme, list layouts) live in localStorage. Signing out wipes that account's data from the device.

## Security

Traffic is encrypted with TLS. Calendar OAuth tokens are encrypted at rest; API tokens and OAuth client secrets are stored only as hashes. Access to production systems is limited to the operator. No system is perfectly secure, so please use a strong account password with your sign-in provider and enable two-factor authentication there.

## Children

The Service is not directed to children under 16 and we do not knowingly collect their data. If you believe a child has created an account, contact us and we will delete it.

## Changes to this policy

We will post any changes here and update the effective date above. Material changes will also be announced in the app before they take effect. Previous versions are available in [the Service's source repository](https://github.com/yuval-yssak/gtd-app/commits/main/client/src/legal/privacy-policy.md).

## Contact

Yuval Yssak · [yuval.yssak@gmail.com](mailto:yuval.yssak@gmail.com)
