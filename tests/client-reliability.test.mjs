import assert from "node:assert/strict";
import test from "node:test";

import {
  listRecoverySessions,
  makeResumeUrl,
  pruneRecoverySessions,
  readActiveCredentials,
  readLegacyCredentials,
  readRecoverySession,
  removeRoomSession,
  saveActiveCredentials,
  saveRecoverySession,
} from "../lib/client/room-session.ts";
import {
  isConfirmedInvalidAuth,
  pollingDelay,
  readRoomJson,
  RoomApiError,
  roomAuthHeaders,
  shouldApplyRoomVersion,
} from "../lib/client/room-transport.ts";

class MemoryStorage {
  #values = new Map();

  constructor(initial = {}) {
    for (const [key, value] of Object.entries(initial)) this.#values.set(key, value);
  }

  get length() {
    return this.#values.size;
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }
}

class ThrowingStorage extends MemoryStorage {
  setItem() {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  }
}

class ReadThrowingStorage extends MemoryStorage {
  getItem() {
    throw new DOMException("Storage is disabled", "SecurityError");
  }
}

class RemoveThrowingStorage extends MemoryStorage {
  removeItem() {
    throw new DOMException("Storage is disabled", "SecurityError");
  }
}

test("recovery and active credentials use separate storage tiers", () => {
  const persistent = new MemoryStorage();
  const active = new MemoryStorage();
  const recovery = {
    code: "ECHO42",
    playerId: "player-a",
    recoveryToken: "recover-secret",
    playerName: "A",
    updatedAt: 5_000,
  };
  const credentials = { playerId: "player-a", playerToken: "active-secret" };

  assert.equal(saveRecoverySession(persistent, recovery), true);
  assert.equal(saveActiveCredentials(active, recovery.code, credentials), true);
  assert.deepEqual(readRecoverySession(persistent, recovery.code), recovery);
  assert.deepEqual(readActiveCredentials(active, recovery.code), credentials);
  assert.equal(readLegacyCredentials(persistent, recovery.code), null);
});

test("a storage write failure is reported without throwing or erasing live credentials", () => {
  const storage = new ThrowingStorage({
    "ink-and-echo:active:ECHO42": JSON.stringify({
      playerId: "player-a",
      playerToken: "still-live",
    }),
  });

  assert.equal(
    saveActiveCredentials(storage, "ECHO42", {
      playerId: "player-a",
      playerToken: "replacement",
    }),
    false,
  );
  assert.deepEqual(readActiveCredentials(storage, "ECHO42"), {
    playerId: "player-a",
    playerToken: "still-live",
  });
});

test("disabled browser storage is treated as unavailable rather than crashing restore", () => {
  const storage = new ReadThrowingStorage();

  assert.equal(readRecoverySession(storage, "ECHO42"), null);
  assert.equal(readActiveCredentials(storage, "ECHO42"), null);
  assert.equal(readLegacyCredentials(storage, "ECHO42"), null);
  assert.deepEqual(listRecoverySessions(storage), []);
});

test("recent rooms are sorted, malformed records ignored, and stale recovery records pruned", () => {
  const storage = new MemoryStorage({
    "ink-and-echo:recovery:OLD111": JSON.stringify({
      code: "OLD111",
      playerId: "old-player",
      recoveryToken: "old-recovery",
      updatedAt: 1_000,
    }),
    "ink-and-echo:recovery:NEW222": JSON.stringify({
      code: "NEW222",
      playerId: "new-player",
      recoveryToken: "new-recovery",
      updatedAt: 9_000,
    }),
    "ink-and-echo:recovery:BROKEN": "{not-json",
    "unrelated": "keep me",
  });

  assert.deepEqual(
    listRecoverySessions(storage).map((session) => session.code),
    ["NEW222", "OLD111"],
  );
  pruneRecoverySessions(storage, 5_000, 10_000);
  assert.deepEqual(
    listRecoverySessions(storage).map((session) => session.code),
    ["NEW222"],
  );
  assert.equal(storage.getItem("unrelated"), "keep me");
});

test("structurally incomplete saved credentials are ignored", () => {
  const storage = new MemoryStorage({
    "ink-and-echo:recovery:ECHO42": JSON.stringify({ code: "ECHO42", updatedAt: 10 }),
    "ink-and-echo:active:ECHO42": JSON.stringify({ playerId: "player-a" }),
    "ink-and-echo:room:ECHO42": JSON.stringify({ playerToken: "token-only" }),
  });

  assert.equal(readRecoverySession(storage, "ECHO42"), null);
  assert.equal(readActiveCredentials(storage, "ECHO42"), null);
  assert.equal(readLegacyCredentials(storage, "ECHO42"), null);
});

test("explicit leave removes recovery, active, and legacy credentials", () => {
  const persistent = new MemoryStorage({
    "ink-and-echo:recovery:ECHO42": "{}",
    "ink-and-echo:room:ECHO42": "{}",
  });
  const active = new MemoryStorage({ "ink-and-echo:active:ECHO42": "{}" });

  removeRoomSession(persistent, active, "ECHO42");

  assert.equal(persistent.length, 0);
  assert.equal(active.length, 0);
});

test("one unavailable storage tier does not prevent clearing the other tier", () => {
  const persistent = new RemoveThrowingStorage({
    "ink-and-echo:recovery:ECHO42": "{}",
  });
  const active = new MemoryStorage({ "ink-and-echo:active:ECHO42": "{}" });

  removeRoomSession(persistent, active, "ECHO42");

  assert.equal(active.length, 0);
});

test("cross-device resume links keep the recovery secret in the URL fragment", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: "https://ink.example/play?old=value" } };
  try {
    const result = new URL(makeResumeUrl("ECHO 42", "player-a", "secret+/="));
    assert.equal(result.searchParams.get("room"), "ECHO 42");
    assert.equal(result.searchParams.has("recoveryToken"), false);
    assert.equal(result.hash, "#resume=player-a.secret%2B%2F%3D");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("room credentials are expressed as headers, never URL parameters", () => {
  const headers = new Headers(
    roomAuthHeaders({ playerId: "player-a", playerToken: "active-secret" }, true),
  );
  assert.equal(headers.get("authorization"), "Bearer active-secret");
  assert.equal(headers.get("x-player-id"), "player-a");
  assert.equal(headers.get("content-type"), "application/json");
});

test("polling backoff is exponential and capped", () => {
  assert.equal(pollingDelay(0), 900);
  assert.equal(pollingDelay(1), 1_800);
  assert.equal(pollingDelay(2), 3_600);
  assert.equal(pollingDelay(3), 7_200);
  assert.equal(pollingDelay(4), 10_000);
  assert.equal(pollingDelay(100), 10_000);
});

test("only a strictly newer finite room version may replace client state", () => {
  assert.equal(shouldApplyRoomVersion(7, 8), true);
  assert.equal(shouldApplyRoomVersion(7, 7), false);
  assert.equal(shouldApplyRoomVersion(7, 6), false);
  assert.equal(shouldApplyRoomVersion(7, 7.5), false);
  assert.equal(shouldApplyRoomVersion(7, Number.NaN), false);
  assert.equal(shouldApplyRoomVersion(7, Number.POSITIVE_INFINITY), false);
});

test("only confirmed 401 credential failures authorize session deletion", () => {
  assert.equal(
    isConfirmedInvalidAuth(new RoomApiError(401, "invalid_player_auth", "bad token")),
    true,
  );
  assert.equal(
    isConfirmedInvalidAuth(new RoomApiError(401, "invalid_recovery_auth", "bad recovery")),
    true,
  );
  assert.equal(
    isConfirmedInvalidAuth(new RoomApiError(500, "room_service_unavailable", "retry")),
    false,
  );
  assert.equal(isConfirmedInvalidAuth(new TypeError("network down")), false);
});

test("HTTP failures retain structured status and error codes", async () => {
  await assert.rejects(
    () => readRoomJson(Response.json({ code: "version_conflict", error: "Refresh" }, { status: 409 })),
    (error) => {
      assert.ok(error instanceof RoomApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "version_conflict");
      return true;
    },
  );
});

test("malformed successful responses are retryable failures, not accepted room state", async () => {
  for (const response of [
    new Response("<html>not json</html>", { status: 200 }),
    Response.json([], { status: 200 }),
  ]) {
    await assert.rejects(
      () => readRoomJson(response),
      (error) => {
        assert.ok(error instanceof RoomApiError);
        assert.equal(isConfirmedInvalidAuth(error), false);
        return true;
      },
    );
  }
});
