import { jsonResponse, readJsonObject, roomErrorResponse } from "@/lib/server/room-http";
import { createRoom, enforceRoomRateLimit } from "@/lib/server/room-service";

export async function POST(request: Request) {
  try {
    await enforceRoomRateLimit(request, "create");
    const body = await readJsonObject(request);
    const result = await createRoom({
      name: body.name,
      playerName: body.playerName,
      settings: body.settings,
    });
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
