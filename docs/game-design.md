# Game design: a party of two

Ink & Echo borrows the joy of an idea changing hands, but its pacing is built specifically for two people. There is no dead audience, no elimination, and no need to simulate a large group. Every action is either a gift to the other player or a response to something they just made.

## Design principles

1. **Alternate often.** One person should rarely take two consecutive creative turns.
2. **Hide just enough.** Comedy comes from a small information gap, not confusing instructions.
3. **Reward callbacks.** Longer games need details that can return and become shared jokes.
4. **Make rough marks feel welcome.** The interface celebrates clarity, nerve, and surprise rather than drawing skill.
5. **End with a keepsake.** The gallery should feel like a small thing the pair made together, not a scoreboard.

There are no points in the initial version. The payoff is comparison, recognition, and reveal. Optional voting or streaks can come later, but competitive scoring should never become the only reason to pay attention to a partner's work.

## Mode recipes

### 1. Classic Chain

**Cadence:** write → draw → guess, then begin a fresh mini-chain.

The reset every third round prevents a two-person chain from getting stuck on one weak guess. Nine rounds creates three complete reveals and gives each player a mix of writing, drawing, and interpreting.

Recommended settings: 9 rounds, 60 seconds, landscape canvas.

### 2. Memory Drift

**Cadence:** original drawing → brief preview → hidden recreation → repeat.

The first preview lasts about eight seconds and trends toward three. Twist cards ramp from gentle constraints (change the mood) to chaotic reinterpretations (dream logic). Players always inherit the latest recreation, not the pristine original.

Recommended settings: 7 rounds, 55 seconds, square canvas.

### 3. Blind Prompt

**Cadence with surprise prompts:** blind drawing every round, with four timed clues.

**Cadence with handmade prompts:** write a secret target and clue ladder → partner draws blind.

The default clue ladder reveals category, mood, approximate setting, then two concrete ingredients. It never reveals the exact target. For handmade rounds, the writer should see a four-field form rather than one generic clue box so clue quality stays playful.

Recommended settings: 6 rounds, 70 seconds, landscape canvas.

### 4. Remix Mode

**Cadence:** original drawing → latest image plus remix card → repeat.

Every remix must preserve one recognizable detail. Rule intensity increases through the game: mood/style nudges first, plot changes in the middle, reality-breaking cards near the finale. This creates evolution without forcing players to redraw the entire scene from scratch.

Recommended settings: 8 rounds, 65 seconds, landscape canvas.

### 5. Speed Chaos

**Cadence:** sprint drawing → snap guess.

Draw timers are capped at 25 seconds and guesses at 15. Prompts should contain one main subject and one visible contradiction. The UI skips confirmation modals during active play except for Clear Canvas; friction is more damaging here than an imperfect submission.

Recommended settings: 10 rounds, 18 seconds, square canvas.

### 6. Story Canvas

**Cadence:** draw a panel → caption it → draw only from the caption.

Story beat cards create an arc: establish, arrival, problem, choice, quiet beat, callback, finale. They are invitations rather than requirements. The final gallery lays entries out as a comic strip and can export the captions and images together.

Recommended settings: 8 rounds, 75 seconds, landscape canvas.

### 7. Guess Evolution

**Cadence:** one seed prompt → draw → guess → draw only the latest guess → repeat.

Unlike Classic Chain, the original prompt never resets. The information firewall is strict: an artist sees only the latest text, and a guesser sees only the latest drawing. The gallery can place the ancestor and final descendant side by side before revealing the middle.

Recommended settings: 9 rounds, 55 seconds, square canvas.

## Original two-person mechanics

### Duo Beats

Some rounds include an optional relationship-sized invitation:

- **Tiny Tribute:** hide a small thing the other player loves.
- **Secret Handshake:** reuse a shape or color from the opening.
- **Yes, and…:** preserve one partner detail exactly before adding a surprise.
- **Keepsake Round:** add one detail only these two people are likely to understand.

These are deliberately optional and never scored. They make a long chain feel personal without asking players to disclose anything.

### Callback Bell

At the midpoint, the progress indicator gives a soft visual chime and surfaces one forgotten early detail as a suggestion. In online rooms, both players see the same callback invitation; only the active player sees the source allowed by the mode.

### Kind Notes

During the gallery, each player may pin one private, preset reaction to an entry: “I love this bit,” “how did we get here?”, “perfectly wrong,” or a heart. Reactions appear only after both players finish reviewing, preventing them from interrupting the chain itself.

### Before / After Curtain

The gallery opens with the first and last entries side by side. A draggable curtain or Reveal button exposes the middle chain. This gives long games a satisfying punchline before the detailed retrospective.

## Page and component map

### Landing

- One-sentence promise: creative chaos made for exactly two.
- Name field, Make a room, Join a friend, and Pass & Play.
- Seven mode cards with emotional description rather than rulebook prose.

### Room setup

- Mode picker with the recommended rounds and timer preloaded when a mode changes.
- Round slider (3–12 in the friendly UI; engine supports up to 20).
- Timer presets plus a custom option.
- Surprise prompt toggle.
- Canvas shape cards with visible aspect ratios.
- A live “Tonight's recipe” summary.

### Waiting room

- Large four-to-six character room code and Copy invite link.
- Exactly two illustrated seats; no empty player grid.
- Host-only Start button enabled after seat 1 arrives.
- Connection status written warmly but plainly.

### Turn workspace

- Top bar: mode chip, round journey, timer.
- A single imperative instruction with the allowed source beneath it.
- Drawing desk or focused text box, never both unless a caption tool is explicitly needed.
- Waiting player sees a calm intermission, not the current secret content.
- Submit button says what will happen: “Pass the doodle” or “Lock in the guess.”

### Gallery

- Before/after reveal followed by chronological chain.
- Turn type, author, prompt/rule context, and per-image download.
- Print layout, image downloads, and a JSON story export in the MVP.
- Later: compose a single long PNG/PDF or comic sheet client-side.

## Drawing desk behavior

The default toolbar order follows what beginners reach for most:

1. pen / eraser;
2. size slider with three quick dots;
3. eight-color palette and advanced color picker;
4. undo / redo;
5. shapes in one expandable group;
6. text;
7. background/fill;
8. fit/reset view;
9. clear canvas behind confirmation.

Keep the currently active tool, color, and brush size visible even when groups collapse. A temporary tool shortcut (hold Space to pan, hold Alt/Option for eyedropper if added) should return to the previous tool on release.

For touch:

- targets are at least 44×44 CSS pixels;
- the canvas captures one drawing pointer but ignores accidental second-finger marks;
- two-finger pinch/pan is allowed only when zoom is enabled;
- controls avoid the bottom browser gesture area;
- no important action exists only on hover.

## Voice and visual direction

The voice is warm, compact, and gently funny. Instructions should reduce anxiety rather than perform comedy at the player's expense:

- Prefer “Big shapes first. One recognizable detail is a victory.”
- Avoid “Draw better” or skill ratings.
- Prefer “The pencil is across the table” while waiting.
- State errors directly, then soften the recovery: “That turn already moved on. Here is the newest one.”

Visually, use warm paper, ink-like navy text, coral/violet/teal accents, slightly imperfect borders, tape/sticker motifs, and a restrained hand-drawn display face. Keep form labels and body text in a highly readable sans serif. Animation should clarify state: a card passing across the screen, a clue unfolding, a gallery chain settling into place. Honor `prefers-reduced-motion` and never animate the actual drawing under a pointer.

## Accessibility checklist

- Every icon button has an accessible name and visible tooltip/focus state.
- Tool selection is not communicated by color alone.
- Canvas operations have keyboard equivalents where practical.
- Text entry and waiting screens remain fully usable without Canvas.
- Announce turn changes, clue reveals, timer warnings, and submission errors in appropriate live regions.
- Do not steal focus when polling updates a room; move focus only on an explicit page/turn transition.
- Provide non-flashing timer urgency and allow hosts to disable timers for a relaxed room in a future setting.
- Exported gallery text remains available as real text, not only burned into an image.

## Replayability without content bloat

Replay comes from recombination rather than thousands of prompts. Eighteen authored prompt cards, twenty remix cards, twelve memory twists, seven story beats, four duo beats, alternating player styles, and deterministic shuffle seeds already create many distinct sessions. New content decks can be added as data files without changing the mode engine.

Future room options that preserve the two-person focus:

- a shared custom word pack;
- “cozy,” “absurd,” or “spooky-light” prompt filters;
- left-handed toolbar placement;
- relaxed untimed play;
- one-use “ask for one more clue” tokens;
- rematch that swaps the starting player and avoids the previous prompt deck order.

