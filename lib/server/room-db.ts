import "server-only";

import { getD1 } from "@/db";

const schemaReady = new WeakMap<object, Promise<void>>();

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY NOT NULL,
    host_player_id TEXT NOT NULL,
    status TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    game_state_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY NOT NULL,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    seat INTEGER NOT NULL CHECK (seat IN (0, 1)),
    token_hash TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_room_seat_uq
    ON players (room_code, seat)`,
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
] as const;

export async function roomDatabase(): Promise<D1Database> {
  const database = getD1();
  let initialization = schemaReady.get(database as object);

  if (!initialization) {
    const created = database
      .batch(SCHEMA_STATEMENTS.map((sql) => database.prepare(sql)))
      .then(() => undefined);
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
