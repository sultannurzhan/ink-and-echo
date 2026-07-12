import {
  credentialsFromRequest,
  jsonResponse,
  readJsonObject,
  roomErrorResponse,
} from "@/lib/server/room-http";
import { enforceRoomRateLimit, performRoomAction } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const headerCredentials = credentialsFromRequest(request);
    await enforceRoomRateLimit(request, "action", `${code}:${headerCredentials.playerId}`);
    const body = await readJsonObject(request);
    const credentials = headerCredentials.playerId && headerCredentials.playerToken
      ? headerCredentials
      : credentialsFromRequest(request, body);
    const nestedAction = body.action && typeof body.action === "object" && !Array.isArray(body.action)
      ? body.action as Record<string, unknown>
      : null;
    const action = nestedAction
      ? {
          ...nestedAction,
          expectedVersion: body.expectedVersion ?? nestedAction.expectedVersion,
        }
      : body;
    const result = await performRoomAction(
      code,
      credentials,
      action,
    );
    return jsonResponse(result);
  } catch (error) {
    return roomErrorResponse(error);
  }
}
