import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolveApiUrl } from "./lib/client/api-url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "INK_");
  const origin = process.env.INK_API_ORIGIN || env.INK_API_ORIGIN || "";
  if (origin) resolveApiUrl("/api/health", origin, true);
  return {
    root: "frontend",
    base: "/ink-and-echo/",
    publicDir: "../public",
    resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
    define: { __INK_API_ORIGIN__: JSON.stringify(origin), __INK_STATIC__: "true" },
    plugins: [react()],
    server: { host: "127.0.0.1", port: 4173, strictPort: true },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
    build: { outDir: "../dist-pages", emptyOutDir: true, sourcemap: false },
  };
});
