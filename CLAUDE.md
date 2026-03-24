# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack GTD (Getting Things Done) productivity app — monorepo with:
- `api-server/` — Node.js/Hono/TypeScript backend on port 4000
- `client/` — React/TypeScript/Vite frontend on port 4173

## Commands

### API Server (`cd api-server`)
```bash
npm run dev          # Start dev server with ts-node-dev (hot reload)
npm run build        # Compile TypeScript to build/
npm run test         # Run Vitest tests
npm run check        # Biome lint check
npm run fix          # Auto-fix lint + format (Biome)
```

### Client (`cd client`)
```bash
npm run dev          # Vite dev server
npm run build        # tsc + vite build
npm run check        # Biome lint check
npm run fix          # Auto-fix lint + format (Biome)
npm run preview      # Preview production build
```

## Architecture

### Auth Flow
Better Auth — Google and GitHub OAuth. Accounts with matching emails are linked to one user. Session stored in MongoDB; HTTP-only cookie `better-auth.session_token`. Client tracks login state in IndexedDB (`localLoggedIn` store) rather than React state.

### Offline-First Design
The client is PWA-capable with a Service Worker. All items are stored in **IndexedDB** (via `idb`) with a `syncOperations` store for queueing changes when offline. The router context passes `db`, `auth`, and `items` to all routes.

### Routing
Uses `@tanstack/react-router` with file-based routing under `client/src/routes/`. Routes under `_authenticated/` are protected. Root layout is in `__root.tsx`.

### Data Access (API)
`abstractDAO.ts` wraps MongoDB — `ItemsDAO` extends it and is initialized in `loaders/mainLoader.ts` as a singleton. Better Auth owns the `user` collection; `UsersDAO` no longer exists.

### Key Types
- **Item** (`GTD task`): categories are `inbox | nextAction | calendar | waitingFor | done | trash`, with optional GTD fields like `workContexts`, `energy`, `time`, `focus`, `urgent`
- **IndexedDB schema**: `MyDB` type in `client/src/types/MyDB.ts`

### Backend Entry Points
- `api-server/src/index.ts` — builds Hono app, starts server, loads DB and auth

### Frontend Entry Points
- `client/src/main.tsx` — initializes IndexedDB, renders app
- `client/src/App.tsx` — sets up router context

## Code Style
- Biome: 160-char line width, 4-space indent, single quotes
- TypeScript strict mode enabled
- Production API CORS origin: `https://getting-things.done.app`

## Coding Standards

### Comments

Whenever making a code change that is not immediately obvious — e.g. a workaround, a non-obvious prop or flag, a subtle timing dependency, or a browser-specific fix — add a concise inline comment explaining why it is needed. One to three lines is usually enough. Skip comments where the code is self-evident.

### File Naming

- Non-component files (hooks, utilities, scripts, etc.): **camelCase** (e.g., `useSomething.tsx`, `myUtil.ts`)
- Component files: **PascalCase** matching the component name (e.g., `MyComponent.tsx`)

### TypeScript
- No `any`. Use `unknown` when the type is genuinely unknown.
- Prefer narrowly inferred types; avoid explicit annotations where inference is accurate.
- Use generics, mapped types, conditional types, and template literal types where they produce more accurate and reusable types than `as` casts.
- Type assertions (`as`) must be rare and justified.

### Functions
- ≤ 5 meaningful actions per function, typically ~5 lines.
- Single level of abstraction per function — if a function orchestrates, it calls named helpers; it does not contain inline implementation details.
- In functions longer than 4 lines, always wrap `return` or `continue` after a condition in curly braces for scannability. In functions of 4 lines or fewer, a single-line form is acceptable:
  ```ts
  // Good — longer function
  if (condition) {
      return;
  }
  // OK — short function (≤ 4 lines)
  if (condition) return;
  ```

### Arguments
- 1–2 arguments preferred; 3 is borderline; 4+ is a violation.
- If arguments are grouped into an object, it must represent a meaningful domain concept, not an arbitrary bag of params.

### Naming
- Names must convey intent precisely. Avoid vague names (`data`, `item`, `temp`, `handle`, `process`).
- Boolean variables/functions must read as predicates: `isLoading`, `hasError`, `canSubmit`.
- Event handlers must describe what happened, not the implementation: `onUserSelected` not `handleClick`.

### Mutability
- `const` everywhere. `let` requires justification. `var` is prohibited.
- If a `let` exists, evaluate whether the mutation can be eliminated by extracting a function or simplifying the logic.

### Abstraction
- A function must operate at a single level of abstraction. When a function mixes levels (orchestration alongside low-level implementation details), extract the lower-level concerns into named helpers.
- Any repeated pattern appearing 2+ times must be extracted to a named abstraction.
- Pagination/streaming → async generator functions.
- Rate-limiting/debouncing → a decorator/wrapper function, not inline logic.

### Functional Programming
- Prefer pure functions, immutability, and function composition over imperative mutation.
- Prefer declarative array methods (`filter`, `map`, `flatMap`, `reduce`) over imperative `for`/`forEach` loops that push into a mutable accumulator. A loop that builds up an array by pushing is a signal to reach for `map`/`flatMap` instead.

### Patterns
- Identify where established patterns (factory, strategy, decorator, observer, repository) would reduce complexity or improve extensibility.
- Flag anti-patterns: god functions, boolean traps, deeply nested conditionals, primitive obsession.

### Dates
- Use `dayjs` for all date parsing, formatting, and manipulation. Do not use the native `Date` API or other date libraries.

### CSS / Styling
- Use CSS Modules for all custom styling. No inline styles, no `styled-components`, no Tailwind, no other CSS-in-JS.
- MUI components are styled via the centralized MUI theme — use `sx` props only for layout-specific overrides on wrapper elements, not for component appearance.
- Global CSS variables go in `client/src/index.css`.
