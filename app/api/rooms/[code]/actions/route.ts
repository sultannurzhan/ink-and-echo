import {
  credentialsFromRequest,
  jsonResponse,
  readJsonObject,
  roomErrorResponse,
} from "@/lib/server/room-http";
import { performRoomAction } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const body = await readJsonObject(request);
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
      credentialsFromRequest(request, body),
      action,
    );
    return jsonResponse(result);
  } catch (error) {
    return roomErrorResponse(error);
  }
}
