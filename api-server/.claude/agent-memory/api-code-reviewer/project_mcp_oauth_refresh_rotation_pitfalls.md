---
name: mcp-oauth-refresh-rotation-pitfalls
description: redeemRefreshToken rotate-before-validate / crash-window / missing-expiry pitfalls — all FIXED 2026-06-24; keep the checklist for future refresh-rotation reviews
metadata:
  type: project
---

`lib/mcpOAuth.ts` `redeemRefreshToken` (remote MCP OAuth 2.1). Three historical hazards — **all FIXED & verified 2026-06-24**:

1. **Rotate-before-validate bricked tokens (C1) — FIXED.** Now a READ-ONLY `findByHash` validates exists/not-revoked/not-expired/not-rotated/client_id-match/secret (via shared `authenticateClient`) BEFORE any mutation. Wrong client_id / bad secret no longer consume the token. Test: "does NOT consume the refresh token on a wrong client_id".
2. **Crash window / sentinel chain unwalkable (C3) — FIXED.** Sentinel approach + `setRotatedTo` are GONE. Now mints the successor FIRST, then `rotate(refreshHash, minted.refreshTokenId, now)` atomically claims rotation AND links predecessor→REAL successor in one op. If `rotate` returns null (concurrent loser), it tears down its own just-minted refresh+access tokens then `revokeFamilyOnReuse`. Worst residual: mint-before-rotate crash leaves an UNREACHABLE orphan successor pair (plaintext never delivered) that TTL-reaps — benign, predecessor stays usable.
3. **`rotate` query missed expiry (C2) — FIXED.** `rotate` filter now has `$or:[{expiresTs absent},{expiresTs:$gt:now}]` mirroring `findActiveUnexpiredByHash`; pre-check also rejects `expiresTs <= now`. Test: "rejects an expired refresh token and mints nothing".

**Concurrent-loser teardown is intentionally aggressive:** the family walk revokes the WINNER's fresh successor too (two requests with same refresh = compromise signal). Winner gets a 200 with immediately-revoked tokens → forced re-auth. Spec-correct, not a bug.

**How to apply:** on ANY refresh-rotation review, re-check (a) validation precedes the irreversible rotate, (b) the chain link is durable across a crash, (c) expiry is in the claim query, (d) race-loser teardown leaves no orphaned LIVE (reachable) token. See [[snapshot-replace-defeats-lww-on-concurrent-edits]] for the broader mutate-then-validate anti-pattern.
