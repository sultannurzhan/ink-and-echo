import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the browser restores sessions without leaking credentials or deleting them on transient errors", async () => {
  const gameApp = await projectFile("components/GameApp.tsx");

  assert.match(gameApp, /roomAuthHeaders\s*\(/);
  assert.match(gameApp, /isConfirmedInvalidAuth\s*\(/);
  assert.match(gameApp, /readRecoverySession|readActiveCredentials/);
  assert.match(gameApp, /\/recover/);
  assert.equal(
    gameApp.match(/playerToken:\s*session\.playerToken/g)?.length,
    1,
    "the active token may be copied to session storage, but not into API bodies",
  );
  assert.doesNotMatch(
    gameApp,
    /new URLSearchParams\s*\(\s*\{[^}]*playerToken/s,
    "authentication secrets must never be placed in polling URLs",
  );

  assert.match(
    gameApp,
    /if\s*\(!isConfirmedInvalidAuth\(cause\)\)[\s\S]{0,500}?return false;[\s\S]{0,250}?removeActiveCredentials/,
    "retryable active-session errors must return without deleting the saved active credential",
  );
});

test("an expired or concurrently rotated recovery token cannot erase a newer saved device session", async () => {
  const gameApp = await projectFile("components/GameApp.tsx");
  assert.match(
    gameApp,
    /const\s+latestRecovery\s*=\s*readRecoverySession[\s\S]{0,500}?recoveryWasRotatedElsewhere[\s\S]{0,500}?if\s*\(override\s*\|\|\s*recoveryWasRotatedElsewhere\)[\s\S]{0,800}?else\s*\{\s*removeRoomSession/,
    "only the credential actually read from device storage may be removed after its confirmed rejection",
  );
});

test("the client drawing byte budget remains below the encoded server payload cap", async () => {
  const [gameApp, imageValidator] = await Promise.all([
    projectFile("components/GameApp.tsx"),
    projectFile("lib/server/image-data-url.ts"),
  ]);
  const clientBytes = Number(gameApp.match(/maxBytes:\s*([\d_]+)/)?.[1]?.replaceAll("_", ""));
  const serverCharacters = Number(
    imageValidator.match(/MAX_IMAGE_DATA_URL_LENGTH\s*=\s*([\d_]+)/)?.[1]?.replaceAll("_", ""),
  );
  assert.ok(Number.isFinite(clientBytes));
  assert.ok(Number.isFinite(serverCharacters));
  assert.ok(Math.ceil(clientBytes / 3) * 4 + 32 <= serverCharacters);
});

test("the polling loop is sequential, abortable, monotonic, and backed off", async () => {
  const gameApp = await projectFile("components/GameApp.tsx");

  assert.match(gameApp, /new AbortController\s*\(/);
  assert.match(gameApp, /signal:\s*[^,}\n]*\.signal/);
  assert.match(gameApp, /\.abort\s*\(\s*\)/);
  assert.match(
    gameApp,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*new AbortController\s*\(\s*\);[\s\S]{0,400}?signal:\s*\1\.signal[\s\S]{0,900}?\1\.signal\.aborted/,
    "each poll must test the same request-local controller whose signal was passed to fetch",
  );
  assert.match(gameApp, /shouldApplyRoomVersion\s*\(/);
  assert.match(gameApp, /pollingDelay\s*\(/);
  assert.doesNotMatch(
    gameApp,
    /setInterval\s*\(\s*async/,
    "an async interval can overlap requests on slow international connections",
  );
});

test("server credential parsing accepts headers and rejects query-string secrets", async () => {
  const roomHttp = await projectFile("lib/server/room-http.ts");

  assert.match(roomHttp, /headers\.get\(["']authorization["']\)/);
  assert.match(roomHttp, /headers\.get\(["']x-player-id["']\)/);
  assert.doesNotMatch(roomHttp, /searchParams\.get\(["']playerToken["']\)/);
  assert.doesNotMatch(roomHttp, /searchParams\.get\(["']token["']\)/);
  assert.doesNotMatch(roomHttp, /searchParams\.get\(["']playerId["']\)/);
});

test("recovery, heartbeat, leave, and deletion have dedicated HTTP routes", async () => {
  const [service, recover, heartbeat, leave, roomRoute] = await Promise.all([
    projectFile("lib/server/room-service.ts"),
    projectFile("app/api/rooms/[code]/recover/route.ts"),
    projectFile("app/api/rooms/[code]/heartbeat/route.ts"),
    projectFile("app/api/rooms/[code]/leave/route.ts"),
    projectFile("app/api/rooms/[code]/route.ts"),
  ]);

  assert.match(service, /export async function recoverRoomSession/);
  assert.match(service, /export async function heartbeatRoom/);
  assert.match(service, /export async function leaveRoom/);
  assert.match(service, /export async function deleteRoom/);
  assert.match(recover, /recoverRoomSession/);
  assert.match(recover, /recoveryToken:\s*body\.recoveryToken/);
  assert.match(service, /invalid_recovery_auth/);
  assert.match(service, /recoveryToken:\s*recoverySecret/);
  assert.match(heartbeat, /heartbeatRoom/);
  assert.match(leave, /leaveRoom/);
  assert.match(roomRoute, /export async function DELETE/);
  assert.match(roomRoute, /deleteRoom/);
});

test("all public room endpoints enforce a scoped rate limit", async () => {
  const routes = [
    ["app/api/rooms/route.ts", "create"],
    ["app/api/rooms/[code]/route.ts", "poll"],
    ["app/api/rooms/[code]/join/route.ts", "join"],
    ["app/api/rooms/[code]/actions/route.ts", "action"],
    ["app/api/rooms/[code]/recover/route.ts", "recover"],
    ["app/api/rooms/[code]/heartbeat/route.ts", "heartbeat"],
    ["app/api/rooms/[code]/leave/route.ts", "leave"],
  ];

  for (const [path, scope] of routes) {
    const source = await projectFile(path);
    assert.match(source, /enforceRoomRateLimit/, `${path} must enforce a rate limit`);
    assert.match(source, new RegExp(`["']${scope}["']`), `${path} must use the ${scope} bucket`);
  }
});

test("room persistence has recovery hashes, activity expiry, and rate-limit expiry", async () => {
  const [schema, runtimeSchema, service] = await Promise.all([
    projectFile("db/schema.ts"),
    projectFile("lib/server/room-db.ts"),
    projectFile("lib/server/room-service.ts"),
  ]);
  const persistence = schema + runtimeSchema;

  assert.match(persistence, /recovery_hash/);
  assert.match(persistence, /last_seen_at/);
  assert.match(persistence, /last_activity_at/);
  assert.match(persistence, /expires_at/);
  assert.match(persistence, /rate_limit_buckets/);
  assert.doesNotMatch(persistence, /recovery_secret/);
  assert.match(service, /tokenHash\(recoverySecret\)/);
  assert.match(service, /room_expired/);
  assert.match(service, /cleanupExpiredRooms/);
});

test("deadline and destructive reset guards are wired into room actions", async () => {
  const service = await projectFile("lib/server/room-service.ts");

  assert.match(service, /isTurnExpired\s*\(\s*state\s*,\s*now/);
  assert.match(service, /turn_expired/);

  const resetStart = service.indexOf('actionType === "reset_game"');
  const submitStart = service.indexOf('actionType === "submit_text"', resetStart);
  assert.ok(resetStart >= 0 && submitStart > resetStart, "expected a reset action branch");
  const resetBranch = service.slice(resetStart, submitStart);
  assert.match(resetBranch, /room\.status\s*!==\s*["']waiting["']/);
  assert.match(resetBranch, /fail\s*\(/);
});

test("leave is replay-safe and gates seat release on the expected room version", async () => {
  const service = await projectFile("lib/server/room-service.ts");
  const leaveStart = service.indexOf("export async function leaveRoom");
  const deleteStart = service.indexOf("export async function deleteRoom", leaveStart);
  assert.ok(leaveStart >= 0 && deleteStart > leaveStart, "expected a leave service branch");
  const leaveBranch = service.slice(leaveStart, deleteStart);

  assert.match(leaveBranch, /authenticateLeaveReplay/);
  assert.match(leaveBranch, /actor\.left_at\s*!==\s*null/);
  const playerUpdate = leaveBranch.indexOf("UPDATE players SET left_at");
  const roomUpdate = leaveBranch.indexOf("UPDATE rooms SET host_player_id");
  assert.ok(playerUpdate >= 0 && roomUpdate > playerUpdate, "seat release must run before room mutation");
  assert.match(leaveBranch.slice(playerUpdate, roomUpdate), /EXISTS\s*\([\s\S]*rooms\.version\s*=\s*\?/);
  assert.match(leaveBranch, /changes\(result\[0\]\)\s*!==\s*1\s*\|\|\s*changes\(result\[1\]\)\s*!==\s*1/);
});
