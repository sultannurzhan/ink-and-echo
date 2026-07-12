import type { RoomCredentials } from "./room-transport";

export type StoredRoomSession = {
  code: string;
  playerId: string;
  recoveryToken?: string;
  playerName?: string;
  phase?: string;
  updatedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const RECOVERY_PREFIX = "ink-and-echo:recovery:";
const ACTIVE_PREFIX = "ink-and-echo:active:";
const LEGACY_PREFIX = "ink-and-echo:room:";

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function validCredentials(value: RoomCredentials | null): value is RoomCredentials {
  return Boolean(value && typeof value.playerId === "string" && value.playerId && typeof value.playerToken === "string" && value.playerToken);
}

function validRecovery(value: StoredRoomSession | null): value is StoredRoomSession {
  return Boolean(value && typeof value.code === "string" && value.code && typeof value.playerId === "string" && value.playerId && typeof value.recoveryToken === "string" && value.recoveryToken && Number.isFinite(value.updatedAt));
}

export function saveRecoverySession(storage: StorageLike, session: StoredRoomSession) {
  try {
    storage.setItem(`${RECOVERY_PREFIX}${session.code}`, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function saveActiveCredentials(
  storage: StorageLike,
  code: string,
  credentials: RoomCredentials,
) {
  try {
    storage.setItem(`${ACTIVE_PREFIX}${code}`, JSON.stringify(credentials));
    return true;
  } catch {
    return false;
  }
}

export function readRecoverySession(storage: StorageLike, code: string) {
  try {
    const value = parse<StoredRoomSession>(storage.getItem(`${RECOVERY_PREFIX}${code}`));
    return validRecovery(value) ? value : null;
  } catch {
    return null;
  }
}

export function readActiveCredentials(storage: StorageLike, code: string) {
  try {
    const value = parse<RoomCredentials>(storage.getItem(`${ACTIVE_PREFIX}${code}`));
    return validCredentials(value) ? value : null;
  } catch {
    return null;
  }
}

export function readLegacyCredentials(storage: StorageLike, code: string) {
  try {
    const value = parse<RoomCredentials>(storage.getItem(`${LEGACY_PREFIX}${code}`));
    return validCredentials(value) ? value : null;
  } catch {
    return null;
  }
}

export function removeActiveCredentials(storage: StorageLike, code: string) {
  try {
    storage.removeItem(`${ACTIVE_PREFIX}${code}`);
  } catch {
    // Storage cleanup is best-effort.
  }
}

export function removeLegacyCredentials(storage: StorageLike, code: string) {
  try {
    storage.removeItem(`${LEGACY_PREFIX}${code}`);
  } catch {
    // Storage cleanup is best-effort.
  }
}

export function listRecoverySessions(storage: StorageLike): StoredRoomSession[] {
  const sessions: StoredRoomSession[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(RECOVERY_PREFIX)) continue;
      const value = parse<StoredRoomSession>(storage.getItem(key));
      if (validRecovery(value)) sessions.push(value);
    }
  } catch {
    return [];
  }
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function removeRoomSession(
  persistentStorage: StorageLike,
  activeStorage: StorageLike,
  code: string,
) {
  try {
    persistentStorage.removeItem(`${RECOVERY_PREFIX}${code}`);
  } catch {
    // Continue clearing other storage tiers independently.
  }
  try {
    persistentStorage.removeItem(`${LEGACY_PREFIX}${code}`);
  } catch {
    // Continue clearing the active credential independently.
  }
  try {
    activeStorage.removeItem(`${ACTIVE_PREFIX}${code}`);
  } catch {
    // A storage failure must never block leaving the current in-memory session.
  }
}

export function pruneRecoverySessions(storage: StorageLike, maxAgeMs: number, now = Date.now()) {
  for (const session of listRecoverySessions(storage)) {
    if (now - session.updatedAt <= maxAgeMs) continue;
    try {
      storage.removeItem(`${RECOVERY_PREFIX}${session.code}`);
    } catch {
      return;
    }
  }
}

export function makeResumeUrl(code: string, playerId: string, recoveryToken: string) {
  if (typeof window === "undefined") return code;
  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(code)}`;
  url.hash = `resume=${encodeURIComponent(`${playerId}.${recoveryToken}`)}`;
  return url.toString();
}
