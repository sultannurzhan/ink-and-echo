import {
  credentialsFromRequest,
  jsonResponse,
  roomErrorResponse,
} from "@/lib/server/room-http";
import {
  deleteRoom,
  enforceRoomRateLimit,
  getRoomSnapshot,
} from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const url = new URL(request.url);
    const rawSinceVersion = url.searchParams.get("sinceVersion");
    const rawSincePresenceVersion = url.searchParams.get("sincePresenceVersion");
    const sinceVersion = rawSinceVersion === null ? undefined : Number(rawSinceVersion);
    const sincePresenceVersion = rawSincePresenceVersion === null
      ? undefined
      : Number(rawSincePresenceVersion);
    const credentials = credentialsFromRequest(request);
    await enforceRoomRateLimit(request, "poll", `${code}:${credentials.playerId}`);
    const snapshot = await getRoomSnapshot(
      code,
      credentials,
      Number.isInteger(sinceVersion) ? sinceVersion : undefined,
      Number.isInteger(sincePresenceVersion) ? sincePresenceVersion : undefined,
    );
    if ("unchanged" in snapshot && snapshot.unchanged) {
      return new Response(null, {
        status: 304,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return jsonResponse(snapshot);
  } catch (error) {
    return roomErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const credentials = credentialsFromRequest(request);
    await enforceRoomRateLimit(request, "delete", `${code}:${credentials.playerId}`);
    return jsonResponse(await deleteRoom(code, credentials));
  } catch (error) {
    return roomErrorResponse(error);
  }
}
