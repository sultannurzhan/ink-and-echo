import "server-only";

import { getD1 } from "@/db";

const schemaReady = new WeakMap<object, Promise<void>>();

const BASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY NOT NULL,
    host_player_id TEXT NOT NULL,
    status TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    game_state_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    last_activity_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY NOT NULL,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    seat INTEGER NOT NULL CHECK (seat IN (0, 1)),
    token_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    left_at INTEGER,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS players_room_idx
    ON players (room_code)`,
  `CREATE TABLE IF NOT EXISTS room_entries (
    id TEXT PRIMARY KEY NOT NULL,
    room_code TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    room_version INTEGER NOT NULL,
    round INTEGER NOT NULL,
    author_player_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text_content TEXT,
    image_data TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_entries_room_ordinal_uq
    ON room_entries (room_code, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_entries_room_version_uq
    ON room_entries (room_code, room_version)`,
  `CREATE INDEX IF NOT EXISTS room_entries_room_idx
    ON room_entries (room_code)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY NOT NULL,
    window_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx
    ON rate_limit_buckets (expires_at)`,
] as const;

const COLUMN_UPGRADES = [
  ["rooms", "last_activity_at", "last_activity_at INTEGER NOT NULL DEFAULT 0"],
  ["rooms", "expires_at", "expires_at INTEGER NOT NULL DEFAULT 0"],
  ["players", "recovery_hash", "recovery_hash TEXT NOT NULL DEFAULT ''"],
  ["players", "last_seen_at", "last_seen_at INTEGER NOT NULL DEFAULT 0"],
  ["players", "left_at", "left_at INTEGER"],
] as const;

async function ensureColumn(
  database: D1Database,
  table: string,
  column: string,
  definition: string,
) {
  const info = await database
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (info.results.some((item) => item.name === column)) return;

  try {
    await database.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
  } catch (error) {
    const refreshed = await database
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    if (!refreshed.results.some((item) => item.name === column)) throw error;
  }
}

async function initializeRoomSchema(database: D1Database) {
  await database.batch(BASE_SCHEMA_STATEMENTS.map((sql) => database.prepare(sql)));
  for (const [table, column, definition] of COLUMN_UPGRADES) {
    await ensureColumn(database, table, column, definition);
  }
  const seatIndex = await database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'players_room_seat_uq'")
    .first<{ sql: string | null }>();
  if (!seatIndex?.sql?.toUpperCase().includes("WHERE")) {
    await database.batch([
      database.prepare("DROP INDEX IF EXISTS players_room_seat_uq"),
      database.prepare(`CREATE UNIQUE INDEX players_room_seat_uq
        ON players (room_code, seat) WHERE left_at IS NULL`),
    ]);
  }
  await database.batch([
    database.prepare("CREATE INDEX IF NOT EXISTS rooms_expiry_idx ON rooms (expires_at)"),
    database.prepare("CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players (last_seen_at)"),
    database.prepare(`UPDATE rooms SET
      last_activity_at = CASE WHEN last_activity_at = 0 THEN updated_at ELSE last_activity_at END,
      expires_at = CASE WHEN expires_at = 0 THEN updated_at + CASE
        WHEN status = 'waiting' THEN 86400000
        WHEN status = 'playing' THEN 172800000
        ELSE 604800000
      END ELSE expires_at END
      WHERE last_activity_at = 0 OR expires_at = 0`),
    database.prepare(`UPDATE players SET last_seen_at = joined_at
      WHERE last_seen_at = 0`),
  ]);
}

export async function roomDatabase(): Promise<D1Database> {
  const database = getD1();
  let initialization = schemaReady.get(database as object);

  if (!initialization) {
    const created = initializeRoomSchema(database);
    schemaReady.set(database as object, created);
    initialization = created;
  }

  try {
    await initialization;
  } catch (error) {
    schemaReady.delete(database as object);
    throw error;
  }

  return database;
}
