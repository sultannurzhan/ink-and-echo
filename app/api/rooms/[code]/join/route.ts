import { jsonResponse, readJsonObject, roomErrorResponse } from "@/lib/server/room-http";
import { joinRoom } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const body = await readJsonObject(request);
    const result = await joinRoom(code, {
      name: body.name,
      playerName: body.playerName,
    });
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    return roomErrorResponse(error);
  }
}
