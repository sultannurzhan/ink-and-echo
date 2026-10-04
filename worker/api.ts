import * as create from "../app/api/rooms/route";
import * as room from "../app/api/rooms/[code]/route";
import * as join from "../app/api/rooms/[code]/join/route";
import * as actions from "../app/api/rooms/[code]/actions/route";
import * as recover from "../app/api/rooms/[code]/recover/route";
import * as leave from "../app/api/rooms/[code]/leave/route";
import * as heartbeat from "../app/api/rooms/[code]/heartbeat/route";
import { withApiHeaders, preflight } from "./http-policy";

interface Env { DB: D1Database; FRONTEND_ORIGIN: string }

const api = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const early = preflight(request, env.FRONTEND_ORIGIN);
    if (early) return early;
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT 1 AS ready").first();
        response = Response.json({ app: "ink-and-echo", database: "ready" });
      } catch {
        response = Response.json({ app: "ink-and-echo", database: "unavailable" }, { status: 503 });
      }
    } else if (url.pathname === "/api/rooms" && request.method === "POST") {
      response = await create.POST(request);
    } else {
      const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(?:\/(join|actions|recover|leave|heartbeat))?$/);
      if (!match) response = Response.json({ error: "Not found" }, { status: 404 });
      else {
        const context = { params: Promise.resolve({ code: match[1] }) };
        const route = match[2];
        if (!route && request.method === "GET") response = await room.GET(request, context);
        else if (!route && request.method === "DELETE") response = await room.DELETE(request, context);
        else if (route && request.method === "POST") {
          const routes = { join, actions, recover, leave, heartbeat };
          response = await routes[route as keyof typeof routes].POST(request, context);
        } else response = Response.json({ error: "Method not allowed" }, { status: 405 });
      }
    }
    return withApiHeaders(response, request, env.FRONTEND_ORIGIN);
  },
};
export default api;
