import type { RoomSettings, StoredGameState } from "./room-game";

export const DEADLINE_GRACE_MS = 1_500;
/**
 * A drawing is substantially larger than the text actions in a room. Give a
 * normal phone connection enough time to finish uploading a drawing that was
 * submitted close to the visible deadline. The grace does not add visible
 * drawing time; it only lets an encode/upload already triggered at zero land.
 */
export const DRAWING_SUBMISSION_GRACE_MS = 15_000;

const DRAWING_TURN_KINDS = new Set([
  "drawing",
  "seed-drawing",
  "memory-drawing",
  "blind-drawing",
  "remix",
]);

export function turnDeadlineGraceMs(
  _settings: RoomSettings,
  state: StoredGameState,
): number {
  return state.currentTurn && DRAWING_TURN_KINDS.has(state.currentTurn.kind)
    ? DRAWING_SUBMISSION_GRACE_MS
    : DEADLINE_GRACE_MS;
}

export function isTurnExpired(
  state: StoredGameState,
  now: number,
  graceMs = DEADLINE_GRACE_MS,
): boolean {
  const deadline = state.currentTurn?.deadlineAt;
  return typeof deadline === "number" && now > deadline + Math.max(0, graceMs);
}
