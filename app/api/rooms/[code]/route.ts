import {
  credentialsFromRequest,
  jsonResponse,
  roomErrorResponse,
} from "@/lib/server/room-http";
import { getRoomSnapshot } from "@/lib/server/room-service";

interface RouteContext {
  params: Promise<{ code: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const url = new URL(request.url);
    const rawSinceVersion = url.searchParams.get("sinceVersion");
    const sinceVersion = rawSinceVersion === null ? undefined : Number(rawSinceVersion);
    const snapshot = await getRoomSnapshot(
      code,
      credentialsFromRequest(request),
      Number.isInteger(sinceVersion) ? sinceVersion : undefined,
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
