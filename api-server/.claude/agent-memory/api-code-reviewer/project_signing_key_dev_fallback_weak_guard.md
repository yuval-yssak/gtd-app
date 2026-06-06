---
name: signing-key-dev-fallback-weak-guard
description: HMAC/crypto-key getters fall back to an in-repo dev key silently; guards are too weak and there's no prod boot-time check
metadata:
  type: project
---

Crypto-key getter helpers in `src/lib/` (tokenEncryption.ts `getKey`, claude/executeToken.ts `getSigningKey`) all share a pattern: read an env var, and on a length-mismatch fall back to a HARDCODED, in-repo dev key. None throw at boot.

**Why this is a review trap:** unlike a missing prod secret that crashes, a misconfigured/truncated key silently produces a working-but-insecure system. The in-repo fallback key is public, so any token signed with it is forgeable. The guards also drift: tokenEncryption uses `hex.length !== 64` (hex), executeToken uses `hex.length >= 32` read as utf8 — `>=` accepts truncated values, and comments claiming "like tokenEncryption.ts" are wrong about the semantics.

**How to apply:** on any new signed/encrypted-token code, demand (1) a boot-time `NODE_ENV==='production'` guard that THROWS if the key env var is unset/too-short, (2) an exact-length-or-minimum-entropy guard (not loose `>=`), and (3) a comment that accurately describes the encoding (hex vs utf8) and does not falsely claim parity with another module. The cross-account/owner re-check guards do NOT compensate for a forgeable token — they only block writing to *another* user's item, not self-scoped bypass of the mint pipeline (spend-cap/audit). Relevant to [[project_lane_a_claude_assist_staged_rollout]].
