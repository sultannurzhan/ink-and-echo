export type RoomCredentials = {
  playerId: string;
  playerToken: string;
};

export class RoomApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RoomApiError";
    this.status = status;
    this.code = code;
  }
}

export function roomAuthHeaders(
  credentials: RoomCredentials,
  includeJson = false,
): HeadersInit {
  return {
    ...(includeJson ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${credentials.playerToken}`,
    "x-player-id": credentials.playerId,
  };
}

export function pollingDelay(failureCount: number, baseMs = 900, maxMs = 10_000) {
  if (failureCount <= 0) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failureCount, 5));
}

export function shouldApplyRoomVersion(currentVersion: number, incomingVersion: number) {
  return Number.isInteger(incomingVersion) && incomingVersion > currentVersion;
}

export function isConfirmedInvalidAuth(error: unknown) {
  return (
    error instanceof RoomApiError &&
    error.status === 401 &&
    (error.code === "invalid_player_auth" || error.code === "invalid_recovery_auth")
  );
}

export async function readRoomJson(response: Response) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RoomApiError(
      response.ok ? 502 : response.status,
      "invalid_room_response",
      "The room server returned an unreadable response. Please try again.",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RoomApiError(
      response.ok ? 502 : response.status,
      "invalid_room_response",
      "The room server returned an unexpected response. Please try again.",
    );
  }
  if (!response.ok) {
    const value = body as { error?: string; code?: string };
    throw new RoomApiError(
      response.status,
      value.code || value.error || "room_request_failed",
      value.error || "Something went sideways. Please try again.",
    );
  }
  return body as Record<string, unknown>;
}
