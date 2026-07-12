import "server-only";

import { RoomServiceError, type PlayerCredentials } from "./room-service";

export const MAX_JSON_BODY_BYTES = 2_000_000;

async function readCappedRequestText(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new RoomServiceError(
      413,
      "request_body_too_large",
      "The request body is too large.",
      { maxBytes: MAX_JSON_BODY_BYTES },
    );
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel("request body too large");
        throw new RoomServiceError(
          413,
          "request_body_too_large",
          "The request body is too large.",
          { maxBytes: MAX_JSON_BODY_BYTES },
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readCappedRequestText(request)) as unknown;
  } catch (error) {
    if (error instanceof RoomServiceError) throw error;
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
    (typeof body.playerId === "string" ? body.playerId : "");
  const playerToken =
    bearer ??
    request.headers.get("x-player-token") ??
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
    const headers = new Headers();
    if (error.status === 401) {
      headers.set("WWW-Authenticate", 'Bearer realm="room-player"');
    }
    if (error.status === 429 && typeof error.details?.retryAfterSeconds === "number") {
      headers.set("Retry-After", String(error.details.retryAfterSeconds));
    }
    return jsonResponse(
      {
        error: error.message,
        code: error.errorCode,
        message: error.message,
        ...error.details,
      },
      { status: error.status, headers },
    );
  }

  console.error("Room API error", error);
  return jsonResponse(
    {
      error: "room_service_unavailable",
      code: "room_service_unavailable",
      message: "The room service is temporarily unavailable.",
    },
    { status: 500 },
  );
}
