import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  hostPlayerId: text("host_player_id").notNull(),
  status: text("status").notNull(),
  settingsJson: text("settings_json").notNull(),
  gameStateJson: text("game_state_json").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

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
    joinedAt: integer("joined_at").notNull(),
  },
  (table) => [
    uniqueIndex("players_room_seat_uq").on(table.roomCode, table.seat),
    index("players_room_idx").on(table.roomCode),
  ],
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
