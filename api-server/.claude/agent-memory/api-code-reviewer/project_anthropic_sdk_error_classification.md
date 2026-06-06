---
name: anthropic-sdk-error-classification
description: How Anthropic SDK APIError surfaces status/message/requestID — load when reviewing claude-assist error handling
metadata:
  type: project
---

Classifying Anthropic SDK errors in claude-assist (`src/lib/claude/agentError.ts`).

Verified empirically against `@anthropic-ai/sdk`:
- `err.requestID` is the accessor (camelCase). `err.request_id` is `undefined` — wrong snake_case silently logs nothing.
- The SDK **ignores the explicit message arg** and regenerates `err.message` as `"<status> <stringified-body-json>"`. So the out-of-credits 400 is only detectable by regex on `err.message` (`/credit balance is too low/i`) — there's no structured `error.type` field exposed for "out of credits". Test fixtures that pass the message as the 3rd ctor arg still produce the same `.message` as the real throw, so the regex match is faithful.
- All subclasses (`AuthenticationError`, `RateLimitError`, `BadRequestError`, `InternalServerError`, `ConflictError`, etc.) are `instanceof APIError` and carry a numeric `.status`.
- `APIConnectionError` and `APIUserAbortError` are also `instanceof APIError` but have `status: undefined` → they fall to the generic 502 branch. The assist route guards `controller.signal.aborted` BEFORE calling the classifier, so timeout-driven aborts never reach it (they go to 504).

**Why:** live testing leaked raw Anthropic credit-balance JSON to the client and logged nothing.
**How to apply:** if a future change matches Anthropic errors by `error.type` or `request_id`, flag it — neither is reliably present; classify by `instanceof` subclass + numeric `.status` + `err.message` regex, and keep the abort guard ahead of the classifier.
