import "server-only";

import { RoomServiceError, type PlayerCredentials } from "./room-service";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new RoomServiceError(400, "invalid_json", "Send a valid JSON request body.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomServiceError(400, "invalid_json", "The JSON body must be an object.");
  }
  return value as Record<string, unknown>;
}

export function credentialsFromRequest(
  request: Request,
  body: Record<string, unknown> = {},
): PlayerCredentials {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const bodyPlayerToken =
    typeof body.playerToken === "string"
      ? body.playerToken
      : typeof body.token === "string"
        ? body.token
        : undefined;
  const playerId =
    request.headers.get("x-player-id") ??
    url.searchParams.get("playerId") ??
    (typeof body.playerId === "string" ? body.playerId : "");
  const playerToken =
    bearer ??
    request.headers.get("x-player-token") ??
    url.searchParams.get("playerToken") ??
    url.searchParams.get("token") ??
    bodyPlayerToken ??
    "";

  return { playerId: playerId.trim(), playerToken: playerToken.trim() };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(body, { ...init, headers });
}

export function roomErrorResponse(error: unknown): Response {
  if (error instanceof RoomServiceError) {
    return jsonResponse(
      {
        error: error.message,
        code: error.errorCode,
        message: error.message,
        ...error.details,
      },
      { status: error.status },
    );
  }

  console.error("Room API error", error);
  return jsonResponse(
    {
      error: "room_service_unavailable",
      message: "The room service is temporarily unavailable.",
    },
    { status: 500 },
  );
}
