import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

test("ships the finished Ink & Echo product shell and social card", async () => {
  const [page, layout, gameApp, styles, socialCard] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/GameApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    stat(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(page, /<GameApp \/>/);
  assert.match(layout, /Ink & Echo — a drawing game for two/);
  assert.match(layout, /og\.png/);
  assert.match(gameApp, /Draw something/);
  assert.match(gameApp, /Change everything/);
  assert.match(gameApp, /Seven ways to lose the plot/);
  assert.match(gameApp, /Make a room/);
  assert.match(gameApp, /Try pass & play/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.ok(socialCard.size > 50_000);
  assert.doesNotMatch(
    page + layout + gameApp,
    /codex-preview|Your site is taking shape|react-loading-skeleton/i,
  );
});

test("ships the two-player room, mode, canvas, and persistence contracts", async () => {
  const [gameApp, canvas, hosting, packageJson, createRoute, actionRoute] =
    await Promise.all([
      readFile(new URL("../components/GameApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/DrawingCanvas.tsx", import.meta.url), "utf8"),
      readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../app/api/rooms/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/rooms/[code]/actions/route.ts", import.meta.url), "utf8"),
    ]);

  const modes = [
    "classic-chain",
    "memory-drift",
    "blind-prompt",
    "remix-mode",
    "speed-chaos",
    "story-canvas",
    "guess-evolution",
  ];
  for (const mode of modes) assert.match(gameApp, new RegExp(`"${mode}"`));

  assert.match(gameApp, /Exactly 2/);
  assert.match(gameApp, /rounds:\s*6/);
  assert.match(gameApp, /\/api\/rooms/);
  assert.match(canvas, /"pen"/);
  assert.match(canvas, /"eraser"/);
  assert.match(canvas, /"fill"/);
  assert.match(canvas, /"rectangle"/);
  assert.match(canvas, /"circle"/);
  assert.match(canvas, /"arrow"/);
  assert.match(canvas, /"text"/);
  assert.match(canvas, /onPointerDown/);
  assert.match(hosting, /"d1":\s*"DB"/);
  assert.match(createRoute, /createRoom/);
  assert.match(actionRoute, /performRoomAction/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
