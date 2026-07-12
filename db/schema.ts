import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  hostPlayerId: text("host_player_id").notNull(),
  status: text("status").notNull(),
  settingsJson: text("settings_json").notNull(),
  gameStateJson: text("game_state_json").notNull(),
  version: integer("version").notNull().default(1),
  lastActivityAt: integer("last_activity_at").notNull().default(0),
  expiresAt: integer("expires_at").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("rooms_expiry_idx").on(table.expiresAt)]);

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    roomCode: text("room_code")
      .notNull()
      .references(() => rooms.code, { onDelete: "cascade" }),
    name: text("name").notNull(),
    seat: integer("seat").notNull(),
    tokenHash: text("token_hash").notNull(),
    recoveryHash: text("recovery_hash").notNull().default(""),
    joinedAt: integer("joined_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull().default(0),
    leftAt: integer("left_at"),
  },
  (table) => [
    uniqueIndex("players_room_seat_uq")
      .on(table.roomCode, table.seat)
      .where(sql`${table.leftAt} IS NULL`),
    index("players_room_idx").on(table.roomCode),
    index("players_last_seen_idx").on(table.lastSeenAt),
  ],
);

export const rateLimitBuckets = sqliteTable(
  "rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("rate_limit_buckets_expiry_idx").on(table.expiresAt)],
);

export const roomEntries = sqliteTable(
  "room_entries",
  {
    id: text("id").primaryKey(),
    roomCode: text("room_code")
      .notNull()
      .references(() => rooms.code, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    roomVersion: integer("room_version").notNull(),
    round: integer("round").notNull(),
    authorPlayerId: text("author_player_id").notNull(),
    kind: text("kind").notNull(),
    textContent: text("text_content"),
    imageData: text("image_data"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("room_entries_room_ordinal_uq").on(
      table.roomCode,
      table.ordinal,
    ),
    uniqueIndex("room_entries_room_version_uq").on(
      table.roomCode,
      table.roomVersion,
    ),
    index("room_entries_room_idx").on(table.roomCode),
  ],
);
