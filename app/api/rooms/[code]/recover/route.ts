import { jsonResponse, readJsonObject, roomErrorResponse } from "@/lib/server/room-http";
import { enforceRoomRateLimit, recoverRoomSession } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    await enforceRoomRateLimit(request, "recover", code.toUpperCase());
    const body = await readJsonObject(request);
    const result = await recoverRoomSession(code, {
      playerId: body.playerId,
      recoverySecret: body.recoverySecret,
      recoveryToken: body.recoveryToken,
    });
    return jsonResponse(result);
  } catch (error) {
    return roomErrorResponse(error);
  }
}
