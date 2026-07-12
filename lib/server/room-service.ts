import "server-only";

import { roomDatabase } from "./room-db";
import {
  addBlindClue,
  advanceAfterDrawing,
  advanceAfterText,
  expectedTextKind,
  initialGameState,
  isDrawingTurn,
  normalizeSettings,
  type EntryDraft,
  type RoomPlayer,
  type RoomSettings,
  type RoomStatus,
  type StoredGameState,
  waitingState,
} from "./room-game";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TEXT_LENGTH = 500;
const MAX_CLUE_LENGTH = 120;
const MAX_IMAGE_DATA_LENGTH = 1_500_000;

interface RoomRow {
  code: string;
  host_player_id: string;
  status: RoomStatus;
  settings_json: string;
  game_state_json: string;
  version: number;
  created_at: number;
  updated_at: number;
}

interface PlayerRow {
  id: string;
  room_code: string;
  name: string;
  seat: number;
  token_hash: string;
  joined_at: number;
}

interface EntryRow {
  id: string;
  room_code: string;
  ordinal: number;
  room_version: number;
  round: number;
  author_player_id: string;
  kind: string;
  text_content: string | null;
  image_data: string | null;
  metadata_json: string;
  created_at: number;
}

export interface PlayerCredentials {
  playerId: string;
  playerToken: string;
}

export interface RoomAction {
  type?: unknown;
  expectedVersion?: unknown;
  text?: unknown;
  imageData?: unknown;
  drawingData?: unknown;
  kind?: unknown;
  settings?: unknown;
}

export class RoomServiceError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    errorCode: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RoomServiceError";
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

function fail(
  status: number,
  errorCode: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new RoomServiceError(status, errorCode, message, details);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function roomCode(): string {
  const random = new Uint8Array(6);
  crypto.getRandomValues(random);
  return Array.from(random, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

export function normalizeRoomCode(value: string): string {
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  if (!new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`).test(code)) {
    fail(400, "invalid_room_code", "Enter a valid six-character room code.");
  }
  return code;
}

function playerName(value: unknown): string {
  if (typeof value !== "string") {
    fail(400, "invalid_player_name", "A player name is required.");
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 24) {
    fail(400, "invalid_player_name", "Player names must be between 1 and 24 characters.");
  }
  return name;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function roomRow(database: D1Database, code: string): Promise<RoomRow> {
  const room = await database
    .prepare(`SELECT code, host_player_id, status, settings_json, game_state_json,
      version, created_at, updated_at FROM rooms WHERE code = ?`)
    .bind(code)
    .first<RoomRow>();
  if (!room) fail(404, "room_not_found", "That room does not exist.");
  return room;
}

async function roomPlayers(database: D1Database, code: string): Promise<PlayerRow[]> {
  const result = await database
    .prepare(`SELECT id, room_code, name, seat, token_hash, joined_at
      FROM players WHERE room_code = ? ORDER BY seat ASC`)
    .bind(code)
    .all<PlayerRow>();
  return result.results;
}

async function authenticate(
  database: D1Database,
  code: string,
  credentials: PlayerCredentials,
): Promise<PlayerRow> {
  if (!credentials.playerId || !credentials.playerToken) {
    fail(401, "player_auth_required", "Player credentials are required.");
  }
  const player = await database
    .prepare(`SELECT id, room_code, name, seat, token_hash, joined_at
      FROM players WHERE room_code = ? AND id = ?`)
    .bind(code, credentials.playerId)
    .first<PlayerRow>();
  if (!player || player.token_hash !== await tokenHash(credentials.playerToken)) {
    fail(401, "invalid_player_auth", "These player credentials are not valid for the room.");
  }
  return player;
}

function publicPlayer(player: PlayerRow, hostPlayerId: string) {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat as 0 | 1,
    isHost: player.id === hostPlayerId,
  };
}

function entryFromRow(row: EntryRow, players: PlayerRow[]) {
  return {
    id: row.id,
    ordinal: row.ordinal,
    round: row.round,
    authorPlayerId: row.author_player_id,
    authorName: players.find((player) => player.id === row.author_player_id)?.name ?? "Player",
    kind: row.kind,
    text: row.text_content,
    imageData: row.image_data,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function hiddenEntry(entry: ReturnType<typeof entryFromRow>) {
  return {
    id: entry.id,
    ordinal: entry.ordinal,
    round: entry.round,
    authorPlayerId: entry.authorPlayerId,
    authorName: entry.authorName,
    kind: entry.kind,
    hidden: true,
  };
}

const DUO_BEATS = [
  "Tiny tribute: hide one small detail your partner will recognize.",
  "Yes, and… preserve one thing they made before adding your twist.",
  "Secret handshake: bring back a shape or color from an earlier turn.",
  "Keepsake beat: add one detail that could become tonight’s inside joke.",
] as const;

function publicTurn(
  state: StoredGameState,
  source: ReturnType<typeof entryFromRow> | ReturnType<typeof hiddenEntry> | null,
  viewerPlayerId: string,
) {
  if (!state.currentTurn) return null;
  const internalTurn = state.currentTurn;
  const turn = {
    kind: internalTurn.kind,
    actorPlayerId: internalTurn.actorPlayerId,
    instruction: internalTurn.instruction,
    sourceEntryId: internalTurn.sourceEntryId,
    suggestedPrompt:
      viewerPlayerId === internalTurn.actorPlayerId
        ? internalTurn.suggestedPrompt
        : undefined,
    rule: internalTurn.rule,
    clues: internalTurn.clues,
    revealUntil: internalTurn.revealUntil,
    deadlineAt: internalTurn.deadlineAt,
  };
  const kind = turn.kind === "drawing"
    ? "draw"
    : turn.kind === "memory-drawing"
      ? "memory"
      : turn.kind === "blind-drawing"
        ? "blind-draw"
        : turn.kind === "seed-drawing"
          ? "draw"
          : turn.kind;
  const visibleSource = source && !("hidden" in source) ? source : null;

  return {
    ...turn,
    kind,
    round: Math.max(1, state.round),
    playerId: turn.actorPlayerId,
    prompt:
      viewerPlayerId === turn.actorPlayerId && turn.suggestedPrompt
        ? turn.suggestedPrompt
        : visibleSource?.text ?? undefined,
    clue: turn.clues?.at(-1),
    duoBeat:
      state.turnNumber > 0 && state.turnNumber % 4 === 0
        ? DUO_BEATS[(state.turnNumber / 4 - 1) % DUO_BEATS.length]
        : undefined,
    previousText: visibleSource?.text ?? undefined,
    previousImage: visibleSource?.imageData ?? undefined,
  };
}

async function snapshotFromRows(args: {
  database: D1Database;
  room: RoomRow;
  players: PlayerRow[];
  viewer: PlayerRow;
}) {
  const { database, room, players, viewer } = args;
  const settings = parseJson<RoomSettings>(room.settings_json, normalizeSettings({}));
  const state = parseJson<StoredGameState>(room.game_state_json, waitingState());
  const entriesResult = await database
    .prepare(`SELECT id, room_code, ordinal, room_version, round, author_player_id,
      kind, text_content, image_data, metadata_json, created_at
      FROM room_entries WHERE room_code = ? ORDER BY ordinal ASC`)
    .bind(room.code)
    .all<EntryRow>();
  const entries = entriesResult.results.map((entry) => entryFromRow(entry, players));
  const turn = state.currentTurn;
  const source = turn?.sourceEntryId
    ? entries.find((entry) => entry.id === turn.sourceEntryId) ?? null
    : null;

  let currentSource: ReturnType<typeof entryFromRow> | ReturnType<typeof hiddenEntry> | null = source;
  if (source && turn?.kind === "blind-drawing" && viewer.id === turn.actorPlayerId) {
    currentSource = hiddenEntry(source);
  }
  if (source && turn?.kind === "memory-drawing" && Date.now() > (turn.revealUntil ?? 0)) {
    currentSource = hiddenEntry(source);
  }

  const status = room.status;
  const gallery = entries.map((entry) => ({
    ...entry,
    playerId: entry.authorPlayerId,
    playerName: entry.authorName,
    rule: typeof entry.metadata.rule === "string" ? entry.metadata.rule : undefined,
  }));
  return {
    code: room.code,
    status,
    phase: status === "waiting" ? "lobby" : status === "finished" ? "gallery" : "playing",
    version: room.version,
    hostPlayerId: room.host_player_id,
    activePlayerId: turn?.actorPlayerId ?? null,
    viewerPlayerId: viewer.id,
    settings,
    players: players.map((player) => publicPlayer(player, room.host_player_id)),
    round: state.round,
    totalRounds: settings.rounds,
    turnNumber: state.turnNumber,
    turnIndex: Math.max(0, state.round - 1),
    totalTurns: settings.rounds,
    currentTurn: publicTurn(state, currentSource, viewer.id),
    currentSource,
    chainLength: entries.length,
    gallery: status === "finished" ? gallery : [],
    createdAt: room.created_at,
    updatedAt: room.updated_at,
  };
}

export async function getRoomSnapshot(
  rawCode: string,
  credentials: PlayerCredentials,
  sinceVersion?: number,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const viewer = await authenticate(database, code, credentials);

  if (Number.isInteger(sinceVersion) && sinceVersion === room.version) {
    return { unchanged: true as const, code, version: room.version };
  }

  const players = await roomPlayers(database, code);
  return snapshotFromRows({ database, room, players, viewer });
}

export async function createRoom(input: {
  name?: unknown;
  playerName?: unknown;
  settings?: unknown;
}) {
  const name = playerName(input.name ?? input.playerName);
  const settings = normalizeSettings(input.settings);
  const database = await roomDatabase();
  const now = Date.now();
  const hostPlayerId = crypto.randomUUID();
  const playerToken = randomToken();
  const hash = await tokenHash(playerToken);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode();
    try {
      await database.batch([
        database
          .prepare(`INSERT INTO rooms (
            code, host_player_id, status, settings_json, game_state_json,
            version, created_at, updated_at
          ) VALUES (?, ?, 'waiting', ?, ?, 1, ?, ?)`)
          .bind(code, hostPlayerId, JSON.stringify(settings), JSON.stringify(waitingState()), now, now),
        database
          .prepare(`INSERT INTO players (
            id, room_code, name, seat, token_hash, joined_at
          ) VALUES (?, ?, ?, 0, ?, ?)`)
          .bind(hostPlayerId, code, name, hash, now),
      ]);

      const room = await roomRow(database, code);
      const players = await roomPlayers(database, code);
      const snapshot = await snapshotFromRows({ database, room, players, viewer: players[0] });
      return {
        room: snapshot,
        player: publicPlayer(players[0], hostPlayerId),
        playerId: hostPlayerId,
        playerToken,
      };
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }

  fail(500, "room_create_failed", "Could not create a room. Please try again.");
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

export async function joinRoom(
  rawCode: string,
  input: { name?: unknown; playerName?: unknown },
) {
  const code = normalizeRoomCode(rawCode);
  const name = playerName(input.name ?? input.playerName);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  if (room.status !== "waiting") {
    fail(409, "game_already_started", "This game has already started.");
  }
  const existingPlayers = await roomPlayers(database, code);
  if (existingPlayers.length >= 2) {
    fail(409, "room_full", "This two-player room is already full.");
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const playerToken = randomToken();
  const hash = await tokenHash(playerToken);

  try {
    const result = await database.batch([
      database
        .prepare(`INSERT INTO players (id, room_code, name, seat, token_hash, joined_at)
          SELECT ?, code, ?, 1, ?, ? FROM rooms
          WHERE code = ? AND status = 'waiting'`)
        .bind(id, name, hash, now, code),
      database
        .prepare(`UPDATE rooms SET version = version + 1, updated_at = ?
          WHERE code = ? AND status = 'waiting'
          AND EXISTS (SELECT 1 FROM players WHERE room_code = ? AND id = ?)`)
        .bind(now, code, code, id),
    ]);
    if (changes(result[0]) !== 1 || changes(result[1]) !== 1) {
      fail(409, "join_conflict", "The room changed while you were joining. Please try again.");
    }
  } catch (error) {
    if (error instanceof RoomServiceError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      fail(409, "room_full", "This two-player room is already full.");
    }
    throw error;
  }

  const updatedRoom = await roomRow(database, code);
  const players = await roomPlayers(database, code);
  const viewer = players.find((player) => player.id === id);
  if (!viewer) fail(409, "join_conflict", "The room changed while you were joining.");
  return {
    room: await snapshotFromRows({ database, room: updatedRoom, players, viewer }),
    player: publicPlayer(viewer, updatedRoom.host_player_id),
    playerId: viewer.id,
    playerToken,
  };
}

function expectedVersion(payload: RoomAction, current: number): number {
  if (payload.expectedVersion === undefined || payload.expectedVersion === null) return current;
  const parsed = Number(payload.expectedVersion);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(400, "invalid_version", "expectedVersion must be a positive integer.");
  }
  if (parsed !== current) {
    fail(409, "version_conflict", "The room changed; refresh its state and try again.", {
      currentVersion: current,
    });
  }
  return parsed;
}

function requireHost(room: RoomRow, player: PlayerRow) {
  if (room.host_player_id !== player.id) {
    fail(403, "host_only", "Only the host can do that.");
  }
}

function requirePlaying(room: RoomRow) {
  if (room.status !== "playing") {
    fail(409, "game_not_playing", "The game is not currently in progress.");
  }
}

function requireActivePlayer(state: StoredGameState, player: PlayerRow) {
  if (!state.currentTurn || state.currentTurn.actorPlayerId !== player.id) {
    fail(403, "not_your_turn", "It is not your turn yet.");
  }
}

function safeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") fail(400, "invalid_text", "Text is required.");
  const text = value.trim();
  if (!text || text.length > maxLength) {
    fail(400, "invalid_text", `Text must be between 1 and ${maxLength} characters.`);
  }
  return text;
}

function safeClue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return safeText(value, MAX_CLUE_LENGTH);
}

function safeImageData(value: unknown): string {
  if (typeof value !== "string" || !value) {
    fail(400, "invalid_drawing", "Drawing image data is required.");
  }
  if (value.length > MAX_IMAGE_DATA_LENGTH) {
    fail(413, "drawing_too_large", "The drawing is too large. Export a smaller canvas image.");
  }
  if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value)) {
    fail(400, "invalid_drawing", "Drawings must be PNG, JPEG, or WebP data URLs.");
  }
  return value;
}

function toGamePlayers(players: PlayerRow[]): RoomPlayer[] {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    seat: player.seat as 0 | 1,
  }));
}

async function updateRoomState(args: {
  database: D1Database;
  room: RoomRow;
  expectedVersion: number;
  state: StoredGameState;
  status?: RoomStatus;
  settings?: RoomSettings;
}) {
  const { database, room, expectedVersion: version, state } = args;
  const result = await database
    .prepare(`UPDATE rooms SET status = ?, settings_json = ?, game_state_json = ?,
      version = version + 1, updated_at = ?
      WHERE code = ? AND version = ?`)
    .bind(
      args.status ?? room.status,
      JSON.stringify(args.settings ?? parseJson<RoomSettings>(room.settings_json, normalizeSettings({}))),
      JSON.stringify(state),
      Date.now(),
      room.code,
      version,
    )
    .run();
  if (changes(result) !== 1) {
    fail(409, "version_conflict", "The room changed; refresh its state and try again.");
  }
}

async function commitEntry(args: {
  database: D1Database;
  room: RoomRow;
  expectedVersion: number;
  state: StoredGameState;
  status: RoomStatus;
  entry: EntryDraft;
}) {
  const { database, room, expectedVersion: version, state, status, entry } = args;
  const result = await database.batch([
    database
      .prepare(`INSERT INTO room_entries (
        id, room_code, ordinal, room_version, round, author_player_id, kind,
        text_content, image_data, metadata_json, created_at
      )
      SELECT ?, room.code,
        COALESCE((SELECT MAX(existing.ordinal) FROM room_entries existing
          WHERE existing.room_code = room.code), 0) + 1,
        room.version + 1, ?, ?, ?, ?, ?, ?, ?
      FROM rooms room
      WHERE room.code = ? AND room.version = ? AND room.status = 'playing'`)
      .bind(
        entry.id,
        entry.round,
        entry.authorPlayerId,
        entry.kind,
        entry.textContent,
        entry.imageData,
        JSON.stringify(entry.metadata),
        entry.createdAt,
        room.code,
        version,
      ),
    database
      .prepare(`UPDATE rooms SET status = ?, game_state_json = ?,
        version = version + 1, updated_at = ?
        WHERE code = ? AND version = ? AND status = 'playing'`)
      .bind(status, JSON.stringify(state), Date.now(), room.code, version),
  ]);

  if (changes(result[0]) !== 1 || changes(result[1]) !== 1) {
    fail(409, "version_conflict", "The room changed; refresh its state and try again.");
  }
}

async function resetRoom(
  database: D1Database,
  room: RoomRow,
  version: number,
) {
  const now = Date.now();
  const result = await database.batch([
    database
      .prepare(`DELETE FROM room_entries WHERE room_code = ?
        AND EXISTS (SELECT 1 FROM rooms WHERE code = ? AND version = ?)`)
      .bind(room.code, room.code, version),
    database
      .prepare(`UPDATE rooms SET status = 'waiting', game_state_json = ?,
        version = version + 1, updated_at = ? WHERE code = ? AND version = ?`)
      .bind(JSON.stringify(waitingState()), now, room.code, version),
  ]);
  if (changes(result[1]) !== 1) {
    fail(409, "version_conflict", "The room changed; refresh its state and try again.");
  }
}

export async function performRoomAction(
  rawCode: string,
  credentials: PlayerCredentials,
  payload: RoomAction,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const actor = await authenticate(database, code, credentials);
  const players = await roomPlayers(database, code);
  const settings = parseJson<RoomSettings>(room.settings_json, normalizeSettings({}));
  const state = parseJson<StoredGameState>(room.game_state_json, waitingState());
  const version = expectedVersion(payload, room.version);
  const actionType = typeof payload.type === "string" ? payload.type : "";
  const now = Date.now();

  if (actionType === "update_settings") {
    requireHost(room, actor);
    if (room.status !== "waiting") {
      fail(409, "settings_locked", "Settings can only be changed in the waiting room.");
    }
    await updateRoomState({
      database,
      room,
      expectedVersion: version,
      state,
      settings: normalizeSettings(payload.settings ?? payload, settings),
    });
  } else if (actionType === "start_game") {
    requireHost(room, actor);
    if (room.status !== "waiting") {
      fail(409, "game_already_started", "The game has already started.");
    }
    if (players.length !== 2) {
      fail(409, "waiting_for_player", "Both players must join before the game starts.");
    }
    await updateRoomState({
      database,
      room,
      expectedVersion: version,
      state: initialGameState(settings, actor.id, now),
      status: "playing",
    });
  } else if (actionType === "reset_game") {
    requireHost(room, actor);
    await resetRoom(database, room, version);
  } else if (actionType === "submit_text") {
    requirePlaying(room);
    requireActivePlayer(state, actor);
    const expectedKind = state.currentTurn ? expectedTextKind(state.currentTurn.kind) : null;
    if (!expectedKind) {
      fail(409, "wrong_submission_type", "This turn needs a drawing, not text.");
    }
    if (payload.kind !== undefined && payload.kind !== expectedKind) {
      fail(400, "wrong_text_kind", `This turn expects a ${expectedKind}.`);
    }
    const text = safeText(payload.text, expectedKind === "caption" ? 280 : MAX_TEXT_LENGTH);
    const entryId = crypto.randomUUID();
    let advanced: ReturnType<typeof advanceAfterText>;
    try {
      advanced = advanceAfterText({
        settings,
        state,
        players: toGamePlayers(players),
        actorPlayerId: actor.id,
        entryId,
        text,
        now,
      });
    } catch (error) {
      fail(409, "invalid_turn", error instanceof Error ? error.message : "That action is not valid now.");
    }
    await commitEntry({
      database,
      room,
      expectedVersion: version,
      state: advanced.state,
      status: advanced.finished ? "finished" : "playing",
      entry: {
        id: entryId,
        round: state.round,
        authorPlayerId: actor.id,
        kind: expectedKind,
        textContent: text,
        imageData: null,
        metadata: { sourceEntryId: state.currentTurn?.sourceEntryId ?? null },
        createdAt: now,
      },
    });
  } else if (actionType === "submit_drawing") {
    requirePlaying(room);
    requireActivePlayer(state, actor);
    const turn = state.currentTurn;
    if (!turn || !isDrawingTurn(turn.kind)) {
      fail(409, "wrong_submission_type", "This turn needs text, not a drawing.");
    }
    const submittedKind = typeof payload.kind === "string" ? payload.kind : undefined;
    const drawingKinds = [
      "drawing",
      "draw",
      "memory",
      "memory-drawing",
      "blind-draw",
      "blind-drawing",
      "remix",
      "seed-drawing",
    ];
    if (submittedKind !== undefined && !drawingKinds.includes(submittedKind)) {
      fail(400, "wrong_drawing_kind", "This turn expects a drawing submission.");
    }
    if (submittedKind === "remix" && turn.kind !== "remix") {
      fail(400, "wrong_drawing_kind", "This is not a remix turn.");
    }
    const imageData = safeImageData(payload.imageData ?? payload.drawingData);
    const entryId = crypto.randomUUID();
    let advanced: ReturnType<typeof advanceAfterDrawing>;
    try {
      advanced = advanceAfterDrawing({
        settings,
        state,
        players: toGamePlayers(players),
        actorPlayerId: actor.id,
        entryId,
        now,
      });
    } catch (error) {
      fail(409, "invalid_turn", error instanceof Error ? error.message : "That action is not valid now.");
    }
    const entryKind = turn.kind === "seed-drawing" ? "drawing" : turn.kind;
    await commitEntry({
      database,
      room,
      expectedVersion: version,
      state: advanced.state,
      status: advanced.finished ? "finished" : "playing",
      entry: {
        id: entryId,
        round: state.round,
        authorPlayerId: actor.id,
        kind: entryKind,
        textContent: null,
        imageData,
        metadata: {
          sourceEntryId: turn.sourceEntryId ?? null,
          rule: turn.rule ?? null,
          clues: turn.kind === "blind-drawing" ? turn.clues ?? [] : undefined,
        },
        createdAt: now,
      },
    });
  } else if (actionType === "add_clue") {
    requirePlaying(room);
    const text = safeClue(payload.text);
    let nextState: StoredGameState;
    try {
      nextState = addBlindClue({
        settings,
        state,
        actorPlayerId: actor.id,
        text,
        now,
      });
    } catch (error) {
      fail(409, "invalid_clue", error instanceof Error ? error.message : "That clue cannot be added now.");
    }
    const clue = nextState.currentTurn?.clues?.at(-1) ?? text;
    await commitEntry({
      database,
      room,
      expectedVersion: version,
      state: nextState,
      status: "playing",
      entry: {
        id: crypto.randomUUID(),
        round: state.round,
        authorPlayerId: actor.id,
        kind: "clue",
        textContent: clue,
        imageData: null,
        metadata: { sourceEntryId: state.currentTurn?.sourceEntryId ?? null },
        createdAt: now,
      },
    });
  } else {
    fail(400, "unknown_action", "Unknown room action.");
  }

  const updatedRoom = await roomRow(database, code);
  const updatedPlayers = await roomPlayers(database, code);
  return {
    room: await snapshotFromRows({
      database,
      room: updatedRoom,
      players: updatedPlayers,
      viewer: actor,
    }),
  };
}
