export function withApiHeaders(response: Response, request: Request, allowedOrigin: string) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Origin");
  if (allowedOrigin && request.headers.get("Origin") === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request: Request, allowedOrigin: string): Response | null {
  const origin = request.headers.get("Origin");
  if (origin && origin !== allowedOrigin && origin !== new URL(request.url).origin) {
    return withApiHeaders(Response.json({ error: "Origin is not allowed" }, { status: 403 }), request, allowedOrigin);
  }
  if (request.method !== "OPTIONS") return null;
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Player-Id",
    "Access-Control-Max-Age": "600",
  });
  return withApiHeaders(new Response(null, { status: 204, headers }), request, allowedOrigin);
}
