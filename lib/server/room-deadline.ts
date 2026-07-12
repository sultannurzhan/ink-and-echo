import type { StoredGameState } from "./room-game";

export const DEADLINE_GRACE_MS = 1_500;

export function isTurnExpired(
  state: StoredGameState,
  now: number,
  graceMs = DEADLINE_GRACE_MS,
): boolean {
  const deadline = state.currentTurn?.deadlineAt;
  return typeof deadline === "number" && now > deadline + Math.max(0, graceMs);
}
