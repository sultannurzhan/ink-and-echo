# Ink & Echo

A cozy drawing game for exactly two people: trade prompts, doodles, guesses and story panels, then keep the journey as a gallery. Seven modes, a drawing desk, recoverable online rooms, and saved pass-and-play games are included.

Source: [sultannurzhan/ink-and-echo](https://github.com/sultannurzhan/ink-and-echo).

Live app: **[Ink & Echo on GitHub Pages](https://sultannurzhan.github.io/ink-and-echo/)**. Multiplayer API: `https://ink-and-echo-api.takibaysultan.workers.dev`. Both were deployed and exercised on 2026-10-05 (Korea time); the backend account remains on Workers Free.

## Architecture

- **GitHub Pages** serves the static React frontend, built with Vite at the repository base path `/ink-and-echo/`.
- A separate **Cloudflare Worker + D1** retains the authoritative multiplayer API. Pages does not run backend code. Multiplayer features are preserved.
- Pass-and-play uses the same pure turn rules as the server, with browser-local saves. Gallery JSON exports can be opened in the app, including original unversioned exports.
- The original vinext build remains available for integrated local development and rollback. `.openai/hosting.json` is retained solely as the old deployment identity; it is not used for new publication.

See [architecture](docs/architecture.md), [game design](docs/game-design.md), [migration and backups](docs/migration.md), and the [audit log](docs/audit-2026-10-05.md).

## Local development

Use Node.js 24 (minimum 22.13), then:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. The integrated server supplies a project-local D1 database; cloud login is unnecessary. All development servers bind only to `127.0.0.1`.

To test the actual split Pages/Worker architecture, use two terminals in this repository:

```sh
# First terminal
npm run dev:api
```

```powershell
# Second terminal (PowerShell)
$env:INK_API_ORIGIN='http://127.0.0.1:8787'
npm run dev:pages
```

Open `http://127.0.0.1:4173/ink-and-echo/`. Use two independent browser sessions for both player seats. **Play these settings on this device** needs no server.

## Checks

```sh
npm run typecheck
npm run lint
npm run test:unit
npm run build:pages
npm run build:api
npm test
```

With `npm run dev:api` running, also run `npm run test:api`. These HTTP tests create fictional rooms and exercise authorization, concurrency, recovery rotation, hidden prompts, gallery persistence and expiry. Nonlocal runs require both `INK_TEST_API` and explicit `INK_ALLOW_LIVE_TEST=ink-and-echo`; they never target the old Site by default.

## Deploy: GitHub Pages plus a free Worker

Keep the existing personal app repository. Never initialize/publish its parent or replace an account-level `owner.github.io` site. Do not enable billing: the backend is intended for Workers Free and D1 Free. Free quotas can interrupt service when exhausted; this is not unlimited hosting.

1. Check `gh auth status`, `gh api user`, and authenticate with `npx wrangler login`. Confirm your personal account, verified email, and **Workers Free** plan. Do not approve a paid upgrade.
2. Inspect `npx wrangler d1 list`. If this app has no database, create one with `npx wrangler d1 create ink-and-echo`. Never reuse an unrelated database.
3. Copy `.env.example` to ignored `.env.local`. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and `CLOUDFLARE_D1_DATABASE_NAME` from those verified resources. These configure only the backend.
4. Run `npm run deploy:api`. It generates ignored `work/wrangler.production.json` and deploys only `ink-and-echo-api`. Production CORS allows exactly `https://sultannurzhan.github.io`. D1 tables initialize on first room use.
5. Set `INK_API_ORIGIN` to the actual HTTPS Worker origin returned by deployment and run `node scripts/check-backend.mjs`. This checks app identity, database health and CORS.
6. Set repository Actions variable `INK_API_ORIGIN` to that public origin (not a secret). Set this repository's Pages source to **GitHub Actions**. The included workflow runs type/lint/unit checks, checks the real backend, builds `dist-pages`, and publishes with standard GitHub Pages actions. It stops before publication if the backend is missing.
7. Push `main` or dispatch the workflow. Obtain the actual URL from its deployment output or `gh api repos/sultannurzhan/ink-and-echo/pages`, then verify it in a browser.

`INK_API_ORIGIN` is the only environment value compiled into the frontend. Never put Cloudflare tokens or database content in a frontend variable. Invitations use `?room=CODE` and private recovery links use a fragment on the index path: refresh/deep links work under the repository subpath without rewrites.

Pages supplies HTTPS but cannot configure arbitrary application HTTP headers. HTML sets a no-referrer policy; the API sends no-store, nosniff, no-referrer and exact-origin CORS headers. No third-party analytics or runtime asset services are used.

Official references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Data and recovery

Online rooms and entries live in D1. Active credentials are in sessionStorage, recovery credentials in localStorage, and unsent drafts in IndexedDB with a localStorage fallback. Only token hashes are stored on the server.

Waiting rooms expire after 24 hours, active rooms after 48 hours of inactivity, and galleries after seven days. Export stories you want to keep. A private recovery link contains a rotating secret in its fragment; share it only to deliberately transfer your own seat.

**Moving to another origin does not move browser storage.** Follow the [migration checklist](docs/migration.md) before retiring the old deployment. Imported stories are local, read-only archives; they do not recreate live rooms or import credentials.

## Modes and drawing

| Mode | Rhythm |
| --- | --- |
| Classic Chain | Prompt → draw → guess → fresh prompt |
| Memory Drift | Opening drawing → brief peek → hidden redraw |
| Blind Prompt | Secret target → clues → blind drawing |
| Remix Mode | Opening drawing → transform the inherited canvas |
| Speed Chaos | Fast prompts, drawings and guesses; at most 25 seconds |
| Story Canvas | Opening panel → caption → next panel |
| Guess Evolution | Prompt → drawing → guess → draw that guess |

The drawing desk supports pen/eraser, colors, paper, shapes, text, zoom, bounded undo/redo, validated image import and image download. Shortcuts: `P`/`E`, `L`/`R`/`O`/`A`, `T`, `[`/`]`, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and `0` to fit. Export composites ink with paper color. Blank/expired turns remain explicit placeholders.

## Licenses and assets

This existing public repository has no app-wide license grant. This migration does not invent one. See [third-party notes](docs/third-party-notices.md). Private stories, credentials, databases and backups do not belong in Git.
