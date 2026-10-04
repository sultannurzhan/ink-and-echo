declare const __INK_API_ORIGIN__: string;
declare const __INK_STATIC__: boolean;

export function resolveApiUrl(path: string, origin: string, staticFrontend = false) {
  if (!path.startsWith("/api/") || path.includes("..") || path.includes("\\")) throw new Error("Invalid room API path.");
  if (!origin) {
    if (staticFrontend) throw new Error("Online rooms need a connected game server. Pass & play and saved stories are available on this device.");
    return path;
  }
  const url = new URL(origin);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The game server address must be an HTTPS origin.");
  }
  return `${url.origin}${path}`;
}

export function apiUrl(path: string) {
  return resolveApiUrl(path,
    typeof __INK_API_ORIGIN__ === "undefined" ? "" : __INK_API_ORIGIN__,
    typeof __INK_STATIC__ !== "undefined" && __INK_STATIC__);
}
