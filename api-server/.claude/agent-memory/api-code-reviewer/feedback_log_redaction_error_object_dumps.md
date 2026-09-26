---
name: log-redaction-error-object-dumps
description: Log-PII reviews must check console.error(msg, err) dumps (GaxiosError config.body carries event summary/description/attendee emails) and calendarId (primary = email), not just template interpolations
metadata:
  type: feedback
---

When reviewing a "logs never contain user content / email addresses" change, grepping `console.*` template strings is not enough.

**Why:** 2026-09-26 legal-terms review: title= interpolations were scrubbed and a regex guard added, but ~30 `console.error('…', err)` sites dump raw GaxiosErrors. gaxios 7's default errorRedactor only redacts auth headers and bodies matching /secret|grant_type|assertion/, so util.inspect prints config.body = the full event JSON (summary, description, location, attendee emails). Separately, `calendarId=${config.calendarId}` logs print the user's email because Google's primary calendar id IS the address. Both passed the guard.

**How to apply:** For any log-redaction/privacy change: (1) probe util.inspect of the real error type the site catches; (2) check id fields that are secretly PII (GCal calendarId, sender addresses); (3) require the static guard to scan all of src/ except CLI/test dirs and to carry a positive-control fixture so a broken regex can't pass vacuously.

**Round-2 finding (verified by mutation, 2026-09-26):** `util.inspect(gaxiosError, {depth: 8})` does NOT render `err.response.config` — the native `Response` hides its extra own props (`data`, `config`) from inspect, yet `JSON.stringify(err.response.config)` still carries the full event body. So an inspect-only runtime test passes with the `data.response?.config` half of a redactor deleted. Demand a direct `err.response.config.data/body` (or JSON) assertion for any redactor that claims to cover the response side.
