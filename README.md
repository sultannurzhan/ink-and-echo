# Ink & Echo

Ink & Echo is a cozy browser drawing game made for exactly two people. Players pass prompts, doodles, guesses, memories, clues, remixes, and story beats back and forth for a host-selected number of rounds, then reveal the entire journey as a keepsake gallery.

It takes inspiration from drawing telephone games without copying their structure: every mode is paced as a duet, long chains remain interesting, and small callback mechanics make a session feel personal rather than like an undersized party lobby.

## What is in the initial version

- Exactly two seats, with host and guest names.
- Create room, join by code, copyable invite URL, and a pass-and-play path.
- Host settings for mode, 3–12 friendly rounds (engine supports 20), timer, prompt sparks, and canvas shape.
- Seven distinct mode schedules.
- Beginner-friendly Canvas 2D desk with freehand, eraser, size/color controls, undo/redo, clear confirmation, background, shapes, text, touch input, and image export.
- Clear turn brief, timer, progress journey, and partner waiting state.
- Versioned room persistence through Cloudflare D1 and low-cost polling.
- Recoverable browser sessions, recent-room shortcuts, safe leave/host transfer, and local turn drafts.
- Server-owned turn deadlines, presence status, request limits, and automatic room expiry.
- End gallery with per-image download, print styling, and JSON story export.
- Deterministic TypeScript game content: prompt cards, progressive clue ladders, remix rules, memory twists, story beats, and optional two-person Duo Beats.

## Stack

- **React 19 + TypeScript** for the application and shared domain model.
- **Vite 8 via vinext** for fast local development, file-based route handlers, and a Cloudflare-ready build.
- **Canvas 2D + Pointer Events** for a small, dependency-free drawing surface across mouse, pen, and touch.
- **Cloudflare Worker + D1** for rooms, player seats, and immutable gallery entries.
- **Plain CSS** for the warm paper-and-ink visual system and responsive layout.

This is intentionally one repository and one deployable application. Polling is a good first realtime solution because there are only two clients and creative turns last much longer than the sub-second update interval.

## Quick start

Prerequisite: Node.js `>=22.13.0`.

```bash
git clone <your-repository-url>
cd ink-and-echo
npm install
npm run dev
```

Open the local URL shown in the terminal, normally `http://localhost:3000`.

No external service is needed for local development. The Vite/Cloudflare integration provides a local D1 binding, and the room tables are initialized on first use.

Useful checks:

```bash
npm run build
npm run lint
npm test
```

To test the true two-device flow locally, open one normal window and one private window, create a room in the first, and join its invite URL in the second. Pass & Play is useful for checking turn cadence without a second session.

## How a game works

1. The host enters a name, chooses **Make a room**, and configures the recipe.
2. Their partner follows the invite link or enters the room code.
3. The host starts once both illustrated seats are filled.
4. The server gives one player a short, mode-specific action and exposes only the allowed source material.
5. Each submitted artifact advances the room to the other player.
6. After the selected mode-aware round recipe is complete, both players see the complete chain.

A “round” is the mode's repeatable creative beat. In Classic Chain, Guess Evolution, and Speed Chaos, each submitted handoff consumes one round; nine Classic rounds are therefore three write/draw/guess mini-chains. Memory Drift and Remix treat the opening seed as a short setup before the chosen transformation rounds, while Blind Prompt and Story Canvas pair two complementary turns inside each round. The progress display follows the same mode-aware definition the host chose.

## Modes

| Mode | Two-player rhythm | Recommended setup |
| --- | --- | --- |
| Classic Chain | write → draw → guess → fresh prompt | 9 rounds · 60 s |
| Memory Drift | original → quick flash → hidden redraw; previews shrink | 7 rounds · 55 s |
| Blind Prompt | timed clues get more useful while the answer stays hidden | 6 rounds · 70 s |
| Remix Mode | inherit the latest drawing and obey an escalating rule | 8 rounds · 65 s |
| Speed Chaos | 25-second-or-less drawing sprints and snap guesses | 10 rounds · 18 s |
| Story Canvas | alternate visual panels and one- or two-line captions | 8 rounds · 75 s |
| Guess Evolution | one seed → draw → guess → draw the latest guess, never reset | 9 rounds · 55 s |

Longer chains get optional **Duo Beats**: tiny invitations to preserve a partner's detail, hide a small tribute, bring back an opening color, or add a final inside joke. They are never scored.

See [Game design](docs/game-design.md) for complete rules, page flow, UI voice, touch behavior, accessibility, and replayability ideas.

## Project structure

```text
app/
  api/rooms/                     room creation, join, read, and actions
  globals.css                    responsive visual system
  layout.tsx
  page.tsx                       mounts the game
components/
  GameApp.tsx                    landing → setup → lobby → game → gallery
  DrawingCanvas.tsx              pointer-based drawing tools
lib/
  game/
    types.ts                     UI-safe domain types
    content.ts                   seven modes and creative content decks
    engine.ts                    deterministic turn planner/state reducer
    index.ts                     public exports
  server/
    room-db.ts                   D1 bootstrap/repository access
    room-game.ts                 authoritative room transitions
db/
  index.ts                       D1 binding
  schema.ts                      Drizzle table definitions
drizzle/                         SQL migrations
worker/index.ts                  Cloudflare worker entry
docs/
  architecture.md               state, API, polling, canvas, security, upgrades
  game-design.md                mode and experience design
```

## Shared game model

The files under `lib/game` are pure TypeScript and import no React, browser, or database APIs. A room seed makes prompt/rule selection reproducible:

```ts
import {
  createTurnPlan,
  normalizeGameSettings,
  redactTurnForPlayer,
} from "@/lib/game";

const settings = normalizeGameSettings({
  mode: "remix-mode",
  roundCount: 8,
  timerSeconds: 60,
  randomPrompts: true,
  canvasPreset: "landscape",
});

const plan = createTurnPlan(settings, {
  seed: "room-ECHO-game-1",
  starterIndex: 0,
});

const safeTurn = redactTurnForPlayer(plan[0], 0, 12);
```

Important exports include:

- content: `GAME_MODES`, `GAME_MODE_BY_ID`, `CANVAS_PRESETS`, `PROMPT_CARDS`, `REMIX_RULES`, `MEMORY_TWISTS`, `STORY_BEATS`, `DUO_BEATS`, `BLIND_CLUE_LADDERS`;
- planning: `normalizeGameSettings`, `createTurnPlan`, `buildBlindClueSchedule`, `getAvailableClues`, `getTurnInstruction`;
- state: `createInitialGameState`, `getActiveTurn`, `getVisibleSource`, `advanceGame`, `getGalleryEntries`, `getRoundProgress`;
- privacy: `redactTurnForPlayer`, `getManualBlindClues`;
- types: `GameModeId`, `GameSettings`, `TurnPlanItem`, `TurnView`, `GameState`, `GameArtifact`, `DrawingSnapshot`, and `PlayerPair`.

The server must still own the actual turn and send the redacted projection. A shared deterministic seed prevents accidental rule drift; it is not permission to send a secret prompt to the drawer.

## Rooms, sessions, and recovery

Rooms move through `waiting → playing → finished/gallery`. D1 stores one versioned room snapshot, exactly two possible player seats, and an immutable chain of prompts, drawings, guesses, and captions. Blind Prompt targets and mode-disallowed history stay redacted until the gallery.

### Browser session model

- The active player token lives in `sessionStorage`, so it is available across refreshes in the current browser session but is not a long-lived local credential.
- A separate recovery token lives in `localStorage`. If the active token is missing or invalid, the recovery endpoint verifies its server-side hash and issues a fresh active token.
- The landing page lists up to three recent rooms saved on this device. **Resume** first tries the active session, then recovery, without asking the player to take a new seat.
- A normal invite is `?room=CODE` and is safe to send to the other player. **Copy my private recovery link** adds the player id and recovery token after `#resume=`. URL fragments are not sent in HTTP requests, and the app removes the fragment after recovery succeeds. Each recovery rotates that secret, so an already-used private link cannot take the seat again. Treat a fresh private link like a password.
- If browser storage is blocked, the game still works while the tab remains open, but refresh and recent-room recovery may be limited. The UI warns the player when this happens.

Only token hashes are stored on the server. A room code finds a room; it does not authorize a player action.

### Local draft recovery

Text and drawing drafts are keyed to the room, player, and exact turn. Text is saved after a short pause; drawings save a compressed ink layer plus the paper color. IndexedDB is preferred, with `localStorage` as a fallback.

On refresh or reconnect, the matching draft is restored automatically. A draft is deleted only after the server confirms the submission, so an uncertain network response does not erase work. Drafts remain on that browser and are never uploaded until **Lock it in** or **Send this masterpiece** is used.

### Realtime, deadlines, and presence

Clients poll by room version about every 900 ms, pause while hidden, wake immediately when the tab returns, and back off to at most 10 seconds after network failures. Same-browser tabs notify each other after a change, while a short local action lease and server-side version check prevent duplicate submissions.

Every timed turn includes `deadlineAt` and `serverNow`. The browser corrects for clock difference, but the server is authoritative: it advances expired turns during reads or actions, accepts only a small 1.5-second transport grace, and rejects late content. Presence is based on authenticated activity/heartbeats; a player is shown as away after about 45 seconds without one.

### Leaving and deleting

**Leave room** asks for confirmation and clears this device's active and recovery credentials only after the server accepts the leave. If the host leaves while the partner remains, host ownership transfers automatically. Leaving during an active game ends the current chain safely so the remaining player can keep the completed history. Leaving as the only player closes the room immediately and schedules its retained tombstone for cleanup, which keeps repeated leave requests safe.

The current host can permanently delete a finished room and gallery. This is separate from merely returning to the home screen.

### Limits and room lifetime

The API returns `429` with a retry time instead of accepting bursts indefinitely:

| Request | Limit |
| --- | --- |
| Create / recover | 10 per 10 minutes |
| Join | 30 per 10 minutes |
| Poll / action | 180 / 60 per minute |
| Heartbeat | 12 per minute |
| Leave | 10 per minute |
| Delete | 5 per 10 minutes |

Activity extends a room's lifetime. Waiting rooms expire after 24 hours, games in progress after 48 hours, and finished galleries after 7 days. Expired rooms and their players/entries are deleted automatically; hosts may delete sooner.

The full model, endpoint payloads, concurrency rules, and storage schema are in [Architecture](docs/architecture.md).

## Drawing implementation

The selected canvas preset determines a stable backing resolution; CSS only changes how large it appears. Pointer positions are transformed into backing coordinates, so drawings remain sharp and correctly aligned on phones and tablets.

The drawing layer stays transparent above a separately tracked paper color. Freehand lines use coalesced pointer samples and quadratic midpoint smoothing; shape tools preview by restoring a temporary `ImageData` snapshot until pointer-up. Undo/redo keeps compressed WebP `Blob` snapshots within a 12 MB mobile or 24 MB desktop budget, and export composites the ink with its paper color. This bounded bitmap history stays dependable without retaining dozens of full PNG strings.

Before an online submission, the canvas prefers WebP (falling back to JPEG), lowers quality if needed, and progressively resizes to at most 1080 px so the transport stays lightweight. The server accepts only PNG, JPEG, or WebP data URLs, caps the encoded payload at 1.5 million characters, verifies the decoded format signature, and rejects unsafe dimensions or pixel counts.

The **Open** tool validates local images before decoding them: PNG/JPEG/WebP only, at most 8 MB, no side longer than 8192 px, and no more than 24 million pixels. Imported files remain local unless the resulting canvas is submitted.

Recommended shortcuts:

| Key | Action |
| --- | --- |
| `P` / `E` | pen / eraser |
| `L` / `R` / `O` / `A` | line / rectangle / ellipse / arrow |
| `T` | text |
| `[` / `]` | smaller / larger brush |
| `Ctrl/Cmd+Z` | undo |
| `Ctrl/Cmd+Shift+Z` | redo |
| `0` | fit canvas |

On touch screens, the drawable surface alone disables browser gestures while drawing; toolbar controls remain normal scrolling targets and are at least 44 CSS pixels.

## Local → GitHub → Sites workflow

The recommended path for this repository is:

1. Develop locally with `npm run dev`. The Cloudflare/Vite plugin supplies a project-local D1 database; no cloud account or `.env` file is required.
2. Before pushing, run `npm test` and verify create/join/resume in two browser sessions.
3. Push the source to GitHub. Do not commit `.env.local`, Cloudflare tokens, or database ids.
4. Import the GitHub repository into OpenAI Sites and publish it. `.openai/hosting.json` declares the D1 binding as `DB`, so Sites can provision and attach it during deployment. Room tables initialize on first use.
5. On the published URL, smoke-test an invite in a private window, refresh both seats, submit one drawing, leave, and resume from the recent-room card.

This is the shortest path to a shareable online game with realtime rooms. Later GitHub pushes can be rebuilt and republished through the same Sites project.

### Direct Cloudflare Workers deployment

vinext has native Cloudflare Workers deployment support.

One-time setup:

1. Push the repository to GitHub.
2. Create a D1 database, for example `npx wrangler d1 create ink-and-echo`.
3. Copy `.env.example` to `.env.local`, then set `CLOUDFLARE_D1_DATABASE_ID` to the database id returned in step 2. The optional `CLOUDFLARE_D1_DATABASE_NAME` defaults to `ink-and-echo`.
4. Authenticate locally with `npx wrangler login`, or add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID` as GitHub Actions secrets.
5. Deploy with `npx vinext deploy`. The build reads the D1 id from the environment and binds it as `DB`; it never relies on the local placeholder id in production.

For continuous deployment, run `npm ci`, `npm test`, and `npx vinext deploy` in GitHub Actions with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID` stored as repository secrets. Cloudflare's Git integration is also suitable when configured with Node 22, the same environment values, and the `DB` binding.

### About GitHub Pages

GitHub Pages can host only a static pass-and-play build. It cannot execute the room route handlers or D1 access in this repository. For a Pages-only deployment, move room persistence/realtime to Supabase (or another hosted backend) and build the browser client as a static Vite application. For the included online two-player rooms, Sites or Cloudflare Workers is the direct option.

## Implementation plan

The project is divided so each layer can be verified independently:

1. **Product shell** — landing, setup, invite, two-seat lobby, turn, wait, and gallery screens with responsive styling.
2. **Shared mode engine** — normalized settings, seven deterministic schedules, progressive rule decks, clue timing, state validation, and secret redaction.
3. **Drawing desk** — pointer coordinate mapping, smooth operations, tools, history, keyboard/touch behavior, and image export.
4. **Room authority** — D1 tables, token authentication, two-seat enforcement, mode transitions, optimistic concurrency, and viewer projections.
5. **Gallery and exports** — complete ordered chain, blind-target reveal, individual downloads, print view, and portable JSON.
6. **Verification** — build/lint, seeded engine tests, room concurrency tests, two-browser smoke test, touch/keyboard pass, and responsive visual QA.
7. **Session hardening** — split active/recovery credentials, recent-room resume, private recovery links, local drafts, server deadlines, presence, safe leave/delete, rate limits, and expiry.
8. **Scale follow-up** — object storage, scheduled cleanup telemetry, abuse controls, and end-to-end browser coverage for recovery and lifecycle edges.

The first seven layers form the current deployable MVP. Complete the scale follow-up before opening anonymous rooms to a large public audience.

## Future realtime upgrade

Polling is isolated behind a small room transport and can be replaced without changing drawing or mode code.

**Supabase path:** move the three tables to Postgres, drawings to Storage, and subscribe to room/entry changes. Keep transitions in an Edge Function/RPC with row-level security and version checks. Store active Blind Prompt targets outside any Realtime publication.

**WebSocket path:** use one Cloudflare Durable Object per room. It serializes both players' actions, broadcasts a viewer-specific projection, owns timer alarms, and writes completed entries to D1/R2. The pure `lib/game` engine and gallery format remain unchanged.

## Product-minded next steps

- Add a single-sheet PNG/PDF comic export.
- Store full drawings in R2 and small thumbnails in room responses.
- Add operational visibility for expiry cleanup, rate-limit pressure, and recovery failures.
- Add opt-in custom prompt packs and cozy/absurd/spooky-light filters.
- Add private gallery reactions such as “perfectly wrong” and “I love this bit.”
- Add a rematch that swaps the starting seat and avoids the previous prompt order.
- Add relaxed untimed rooms and reduced-motion-specific transitions.

## License

Choose a license before making the repository public. MIT is a straightforward default for a small web game starter.
