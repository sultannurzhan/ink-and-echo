import {
  credentialsFromRequest,
  jsonResponse,
  roomErrorResponse,
} from "@/lib/server/room-http";
import { enforceRoomRateLimit, leaveRoom } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const credentials = credentialsFromRequest(request);
    await enforceRoomRateLimit(request, "leave", `${code}:${credentials.playerId}`);
    return jsonResponse(await leaveRoom(code, credentials));
  } catch (error) {
    return roomErrorResponse(error);
  }
}
