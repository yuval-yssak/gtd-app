---
name: render-consumed-ref-vs-lazy-mount
description: One-shot flags read AND reset during render (ref) are lost when the consumer is a lazy()/Suspense child that captures the prop only at its own later mount; keep the request in state for the session.
metadata:
  type: project
---

A "focus on next mount" ref read+reset in render silently dropped autofocus for the lazy CodeMirror notes editor: any parent re-render while the chunk loaded passed `false`, and the view reads `autoFocus` once at mount. Surfaced only on a newer Chromium (timing), passed on the older browser. Fixed 2026-10 by moving the request into state for the whole edit session.

**Why:** render can run many times before a Suspense child mounts (and StrictMode double-renders), so render-time side effects on refs are not one-shot.
**How to apply:** when reviewing any mount-only prop fed to a lazy/Suspense child, flag ref mutation during render; also check the error-boundary fallback (textarea autoFocus) gets the same value.
