---
name: rsvp-ops-have-null-snapshot-not-delete
description: opType 'rsvp' ops persist with snapshot:null but are NOT 'delete' — any snapshot-equality logic must special-case rsvp or it silently collapses/misclassifies them
metadata:
  type: project
---

`opType: 'rsvp'` operations are persisted into the `operations` collection with `snapshot: null` and the real payload in the `rsvp` sidecar (see applyOperation.ts ~line 116-118). They are NOT `delete` ops.

**Why:** Any logic that branches on `snapshot === null` to mean "delete", or that deep-equals `snapshot` to detect duplicates, will misclassify rsvp ops. Two consecutive rsvp ops both stableStringify to `'null'` and look identical even when their `rsvp` payloads (and thus their effect) differ — so a snapshot-only equality check collapses distinct rsvp ops.

**How to apply:** On any op-classification or op-dedup/equality code, check `opType === 'delete'` explicitly AND treat `opType === 'rsvp'` as a never-collapse / never-equal case (it carries no snapshot but is meaningful). When reviewing the dedup-operations path, verify the equality key incorporates opType+rsvp, not just snapshot. Related: [[project_v1_post_handlers_skip_zod_catch]].
