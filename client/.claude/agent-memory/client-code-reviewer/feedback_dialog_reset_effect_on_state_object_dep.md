---
name: dialog-reset-effect-on-state-object-dep
description: Settings dialogs seed a local field via useEffect keyed on the whole discriminated-state object; flag the identity-fragility and prefer key-remount.
metadata:
  type: feedback
---

Settings-section dialogs (RenameDeviceDialog, and the PersonalApiTokens/CalendarIntegrations family it's modeled on) seed a local editable field from props inside a `useEffect` whose dep array includes the entire discriminated `state` object (`{phase:'open',device}`), guarding the body on `isOpen`.

**Why:** This "works" only because the parent keeps a stable object reference for the open-state across re-renders (e.g. when a background `refresh()` resolves and updates the list). If a future refactor recreates that state object on render while the dialog is open, the effect re-fires and wipes the user's in-progress typing back to the seeded value. It's the exact class of thing client/CLAUDE.md "avoid useEffect for derived state" targets.

**How to apply:** When reviewing a new Settings dialog that resets a field on open, don't just check "does it re-seed on reopen with a different entity" (that part is usually right). Also flag the whole-object dep as fragile and recommend either keying on the stable id only (`state.device.deviceId`) or `<Dialog key={entityId}>` remount + drop the effect (React 19 preference). Non-blocking, but call it out every time.
