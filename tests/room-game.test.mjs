import assert from "node:assert/strict";
import test from "node:test";

import {
  addBlindClue,
  advanceAfterDrawing,
  advanceAfterText,
  initialGameState,
  normalizeSettings,
} from "../lib/server/room-game.ts";
import {
  DEADLINE_GRACE_MS,
  DRAWING_SUBMISSION_GRACE_MS,
  isTurnExpired,
  turnDeadlineGraceMs,
} from "../lib/server/room-deadline.ts";

const players = [
  { id: "player-a", name: "A", seat: 0 },
  { id: "player-b", name: "B", seat: 1 },
];

function settings(mode, overrides = {}) {
  return normalizeSettings({
    mode,
    rounds: 4,
    timerSeconds: 90,
    randomPrompts: false,
    canvasSize: "classic",
    ...overrides,
  });
}

function submitText(gameSettings, state, actorPlayerId, now, suffix = "1") {
  return advanceAfterText({
    settings: gameSettings,
    state,
    players,
    actorPlayerId,
    entryId: `text-${suffix}`,
    text: `idea ${suffix}`,
    now,
  });
}

function submitDrawing(gameSettings, state, actorPlayerId, now, suffix = "1") {
  return advanceAfterDrawing({
    settings: gameSettings,
    state,
    players,
    actorPlayerId,
    entryId: `drawing-${suffix}`,
    now,
  });
}

function assertTurn(state, kind, actorPlayerId, deadlineAt) {
  assert.ok(state.currentTurn, "expected an active turn");
  assert.equal(state.currentTurn.kind, kind);
  assert.equal(state.currentTurn.actorPlayerId, actorPlayerId);
  assert.equal(state.currentTurn.deadlineAt, deadlineAt);
}

test("Classic Chain and Guess Evolution alternate players on every handoff", () => {
  for (const mode of ["classic-chain", "guess-evolution"]) {
    const gameSettings = settings(mode);
    const initial = initialGameState(gameSettings, "player-a", 1_000);
    assertTurn(initial, "prompt", "player-a", 91_000);

    const afterPrompt = submitText(gameSettings, initial, "player-a", 2_000, mode);
    assert.equal(afterPrompt.finished, false);
    assertTurn(afterPrompt.state, "drawing", "player-b", 92_000);

    const afterDrawing = submitDrawing(
      gameSettings,
      afterPrompt.state,
      "player-b",
      3_000,
      mode,
    );
    assert.equal(afterDrawing.finished, false);
    assertTurn(afterDrawing.state, "guess", "player-a", 93_000);
  }
});

test("Memory Drift and Remix Mode pass each drawing back to the partner", () => {
  for (const [mode, repeatingKind] of [
    ["memory-drift", "memory-drawing"],
    ["remix-mode", "remix"],
  ]) {
    const gameSettings = settings(mode);
    const initial = initialGameState(gameSettings, "player-a", 10_000);
    assertTurn(initial, "seed-drawing", "player-a", 100_000);

    const first = submitDrawing(gameSettings, initial, "player-a", 11_000, mode);
    assertTurn(first.state, repeatingKind, "player-b", 101_000);

    const second = submitDrawing(
      gameSettings,
      first.state,
      "player-b",
      12_000,
      `${mode}-2`,
    );
    assertTurn(second.state, repeatingKind, "player-a", 102_000);
  }
});

test("Story Canvas never gives the caption writer the immediately following drawing", () => {
  const gameSettings = settings("story-canvas");
  const initial = initialGameState(gameSettings, "player-a", 20_000);
  assertTurn(initial, "drawing", "player-a", 110_000);

  const caption = submitDrawing(gameSettings, initial, "player-a", 21_000, "panel-1");
  assertTurn(caption.state, "caption", "player-b", 111_000);

  const nextPanel = submitText(
    gameSettings,
    caption.state,
    "player-b",
    22_000,
    "caption-1",
  );
  assertTurn(nextPanel.state, "drawing", "player-a", 112_000);
});

test("Speed Chaos applies its server deadlines to every generated turn", () => {
  const gameSettings = settings("speed-chaos", { timerSeconds: 25 });
  const initial = initialGameState(gameSettings, "player-a", 30_000);
  assertTurn(initial, "drawing", "player-a", 55_000);

  const guess = submitDrawing(gameSettings, initial, "player-a", 31_000, "speed-1");
  assertTurn(guess.state, "guess", "player-b", 46_000);

  const drawing = submitText(
    gameSettings,
    guess.state,
    "player-b",
    32_000,
    "speed-guess",
  );
  assertTurn(drawing.state, "drawing", "player-a", 57_000);
});

test("Blind Prompt clues extend the deadline without advancing creative progress", () => {
  const gameSettings = settings("blind-prompt", { timerSeconds: 90 });
  const initial = initialGameState(gameSettings, "player-a", 40_000);
  const blindDrawing = submitText(
    gameSettings,
    initial,
    "player-a",
    41_000,
    "secret",
  ).state;
  assertTurn(blindDrawing, "blind-drawing", "player-b", 131_000);

  const originalTurnNumber = blindDrawing.turnNumber;
  const withClue = addBlindClue({
    settings: gameSettings,
    state: blindDrawing,
    actorPlayerId: "player-b",
    text: "",
    now: 120_000,
  });

  assert.equal(
    withClue.turnNumber,
    originalTurnNumber,
    "a clue is metadata for the current turn, not a creative handoff",
  );
  assert.equal(withClue.currentTurn.deadlineAt, 140_000);
  assert.equal(withClue.currentTurn.actorPlayerId, "player-b");
  assert.equal(withClue.currentTurn.clues.length, 2);
});

test("a mode finishes without manufacturing a turn beyond the selected rounds", () => {
  const gameSettings = settings("speed-chaos", { rounds: 3, timerSeconds: 25 });
  const initial = initialGameState(gameSettings, "player-a", 50_000);
  const guess = submitDrawing(gameSettings, initial, "player-a", 51_000).state;
  const drawing = submitText(gameSettings, guess, "player-b", 52_000).state;
  const finished = submitDrawing(gameSettings, drawing, "player-a", 53_000);

  assert.equal(finished.finished, true);
  assert.equal(finished.state.currentTurn, null);
  assert.equal(finished.state.round, 3);
});

test("the authoritative deadline guard allows its grace window and rejects late turns", () => {
  const state = initialGameState(settings("classic-chain"), "player-a", 100_000);
  const deadline = state.currentTurn.deadlineAt;

  assert.equal(isTurnExpired(state, deadline), false);
  assert.equal(isTurnExpired(state, deadline + DEADLINE_GRACE_MS), false);
  assert.equal(isTurnExpired(state, deadline + DEADLINE_GRACE_MS + 1), true);
  assert.equal(isTurnExpired(state, deadline + 1, 0), true);
  assert.equal(isTurnExpired(state, deadline + 1, -5_000), true);
  assert.equal(
    isTurnExpired({ ...state, currentTurn: null }, deadline + 1_000_000),
    false,
  );
});

test("every drawing mode gets upload grace without extending its visible timer", () => {
  const classicSettings = settings("classic-chain");
  const prompt = initialGameState(classicSettings, "player-a", 100_000);
  assert.equal(turnDeadlineGraceMs(classicSettings, prompt), DEADLINE_GRACE_MS);

  const drawing = submitText(
    classicSettings,
    prompt,
    "player-a",
    101_000,
    "upload-grace",
  ).state;
  const drawingDeadline = drawing.currentTurn.deadlineAt;
  assert.equal(
    turnDeadlineGraceMs(classicSettings, drawing),
    DRAWING_SUBMISSION_GRACE_MS,
  );
  assert.equal(
    isTurnExpired(drawing, drawingDeadline + DEADLINE_GRACE_MS + 1, turnDeadlineGraceMs(classicSettings, drawing)),
    false,
  );
  assert.equal(
    isTurnExpired(drawing, drawingDeadline + DRAWING_SUBMISSION_GRACE_MS + 1, turnDeadlineGraceMs(classicSettings, drawing)),
    true,
  );

  const speedSettings = settings("speed-chaos", { timerSeconds: 25 });
  const speedDrawing = initialGameState(speedSettings, "player-a", 200_000);
  assert.equal(turnDeadlineGraceMs(speedSettings, speedDrawing), DRAWING_SUBMISSION_GRACE_MS);
  assert.equal(
    isTurnExpired(
      speedDrawing,
      speedDrawing.currentTurn.deadlineAt + DEADLINE_GRACE_MS + 1,
      turnDeadlineGraceMs(speedSettings, speedDrawing),
    ),
    false,
  );
  assert.equal(
    isTurnExpired(
      speedDrawing,
      speedDrawing.currentTurn.deadlineAt + DRAWING_SUBMISSION_GRACE_MS + 1,
      turnDeadlineGraceMs(speedSettings, speedDrawing),
    ),
    true,
  );
});
