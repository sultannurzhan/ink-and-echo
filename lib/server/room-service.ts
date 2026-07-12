import "server-only";

import {
  ImageDataUrlValidationError,
  validateImageDataUrl,
} from "./image-data-url";
import { roomDatabase } from "./room-db";
import { isTurnExpired, turnDeadlineGraceMs } from "./room-deadline";
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
const ONLINE_WINDOW_MS = 45_000;
const PRESENCE_WRITE_INTERVAL_MS = 10_000;
const WAITING_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PLAYING_RETENTION_MS = 48 * 60 * 60 * 1_000;
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
interface RoomRow {
  code: string;
  host_player_id: string;
  status: RoomStatus;
  settings_json: string;
  game_state_json: string;
  version: number;
  last_activity_at: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface PlayerRow {
  id: string;
  room_code: string;
  name: string;
  seat: number;
  token_hash: string;
  recovery_hash: string;
  joined_at: number;
  last_seen_at: number;
  left_at: number | null;
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

interface EntryMetaRow {
  id: string;
  ordinal: number;
  round: number;
  author_player_id: string;
  kind: string;
  metadata_json: string;
  created_at: number;
  has_text: number;
  has_image: number;
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

interface RateLimitRow {
  request_count: number;
  window_started_at: number;
}

export type RoomRateLimitScope =
  | "create"
  | "join"
  | "poll"
  | "action"
  | "recover"
  | "heartbeat"
  | "leave"
  | "delete";

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

const RATE_LIMITS: Record<RoomRateLimitScope, { limit: number; windowMs: number }> = {
  create: { limit: 10, windowMs: 10 * 60_000 },
  join: { limit: 30, windowMs: 10 * 60_000 },
  poll: { limit: 180, windowMs: 60_000 },
  action: { limit: 60, windowMs: 60_000 },
  recover: { limit: 10, windowMs: 10 * 60_000 },
  heartbeat: { limit: 12, windowMs: 60_000 },
  leave: { limit: 10, windowMs: 60_000 },
  delete: { limit: 5, windowMs: 10 * 60_000 },
};
const GLOBAL_IP_RATE_LIMIT = { limit: 300, windowMs: 60_000 } as const;

function requestAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    "local"
  ).slice(0, 80);
}

export async function enforceRoomRateLimit(
  request: Request,
  scope: RoomRateLimitScope,
  identity = "anonymous",
) {
  const database = await roomDatabase();
  const now = Date.now();
  const config = RATE_LIMITS[scope];
  const address = requestAddress(request);
  const globalRow = await consumeRateBucket(
    database,
    `global-ip:${address}`,
    now,
    GLOBAL_IP_RATE_LIMIT.windowMs,
  );
  enforceRateBucketResult(globalRow, GLOBAL_IP_RATE_LIMIT, now);

  const scopedRow = await consumeRateBucket(
    database,
    `${scope}:${address}:${identity.slice(0, 100)}`,
    now,
    config.windowMs,
  );
  enforceRateBucketResult(scopedRow, config, now);

  const random = new Uint8Array(1);
  crypto.getRandomValues(random);
  if (random[0] < 8) {
    await database
      .prepare("DELETE FROM rate_limit_buckets WHERE expires_at < ?")
      .bind(now)
      .run();
  }
}

async function consumeRateBucket(
  database: D1Database,
  bucketKey: string,
  now: number,
  windowMs: number,
): Promise<RateLimitRow> {
  const resetBefore = now - windowMs;
  const row = await database
    .prepare(`INSERT INTO rate_limit_buckets (
      bucket_key, window_started_at, request_count, expires_at
    ) VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      request_count = CASE
        WHEN rate_limit_buckets.window_started_at <= ? THEN 1
        ELSE rate_limit_buckets.request_count + 1
      END,
      window_started_at = CASE
        WHEN rate_limit_buckets.window_started_at <= ? THEN excluded.window_started_at
        ELSE rate_limit_buckets.window_started_at
      END,
      expires_at = excluded.expires_at
    RETURNING request_count, window_started_at`)
    .bind(bucketKey, now, now + windowMs * 2, resetBefore, resetBefore)
    .first<RateLimitRow>();

  if (!row) fail(500, "rate_limit_unavailable", "Could not check the request limit.");
  return row;
}

function enforceRateBucketResult(
  row: RateLimitRow,
  config: { limit: number; windowMs: number },
  now: number,
) {
  if (row.request_count > config.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((row.window_started_at + config.windowMs - now) / 1_000),
    );
    fail(429, "rate_limited", "Too many requests. Please pause briefly and try again.", {
      retryAfterSeconds,
    });
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parsePersistedObject<T>(value: string, label: string): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    fail(500, "invalid_persisted_state", `The stored ${label} is unreadable. Please delete this room and start a new one.`);
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

function retentionMs(status: RoomStatus): number {
  if (status === "waiting") return WAITING_RETENTION_MS;
  if (status === "playing") return PLAYING_RETENTION_MS;
  return FINISHED_RETENTION_MS;
}

function nextExpiry(status: RoomStatus, now: number): number {
  return now + retentionMs(status);
}

async function deleteRoomData(database: D1Database, code: string) {
  await database.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
}

export async function cleanupExpiredRooms(database?: D1Database) {
  const target = database ?? await roomDatabase();
  const now = Date.now();
  const expired = await target
    .prepare(`SELECT code FROM rooms WHERE expires_at > 0 AND expires_at < ?
      ORDER BY expires_at ASC LIMIT 20`)
    .bind(now)
    .all<{ code: string }>();
  if (!expired.results.length) return 0;

  const placeholders = expired.results.map(() => "?").join(", ");
  const codes = expired.results.map((room) => room.code);
  await target.batch([
    target
      .prepare(`DELETE FROM room_entries WHERE room_code IN (${placeholders})`)
      .bind(...codes),
    target
      .prepare(`DELETE FROM players WHERE room_code IN (${placeholders})`)
      .bind(...codes),
    target
      .prepare(`DELETE FROM rooms WHERE code IN (${placeholders})`)
      .bind(...codes),
  ]);
  return codes.length;
}

async function roomRow(database: D1Database, code: string): Promise<RoomRow> {
  const room = await database
    .prepare(`SELECT code, host_player_id, status, settings_json, game_state_json,
      version, last_activity_at, expires_at, created_at, updated_at
      FROM rooms WHERE code = ?`)
    .bind(code)
    .first<RoomRow>();
  if (!room) fail(404, "room_not_found", "That room does not exist.");
  if (room.expires_at > 0 && room.expires_at < Date.now()) {
    await deleteRoomData(database, code);
    fail(410, "room_expired", "This room has expired.");
  }
  return room;
}

async function roomPlayers(database: D1Database, code: string): Promise<PlayerRow[]> {
  const result = await database
    .prepare(`SELECT id, room_code, name, seat, token_hash, recovery_hash,
      joined_at, last_seen_at, left_at
      FROM players WHERE room_code = ? AND left_at IS NULL ORDER BY seat ASC`)
    .bind(code)
    .all<PlayerRow>();
  return result.results;
}

async function allRoomPlayers(database: D1Database, code: string): Promise<PlayerRow[]> {
  const result = await database
    .prepare(`SELECT id, room_code, name, seat, token_hash, recovery_hash,
      joined_at, last_seen_at, left_at
      FROM players WHERE room_code = ? ORDER BY joined_at ASC`)
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
    .prepare(`SELECT id, room_code, name, seat, token_hash, recovery_hash,
      joined_at, last_seen_at, left_at
      FROM players WHERE room_code = ? AND id = ? AND left_at IS NULL`)
    .bind(code, credentials.playerId)
    .first<PlayerRow>();
  if (!player || player.token_hash !== await tokenHash(credentials.playerToken)) {
    fail(401, "invalid_player_auth", "These player credentials are not valid for the room.");
  }
  return player;
}

async function authenticateLeaveReplay(
  database: D1Database,
  code: string,
  credentials: PlayerCredentials,
): Promise<PlayerRow> {
  if (!credentials.playerId || !credentials.playerToken) {
    fail(401, "player_auth_required", "Player credentials are required.");
  }
  const player = await database
    .prepare(`SELECT id, room_code, name, seat, token_hash, recovery_hash,
      joined_at, last_seen_at, left_at
      FROM players WHERE room_code = ? AND id = ?`)
    .bind(code, credentials.playerId)
    .first<PlayerRow>();
  if (!player || player.token_hash !== await tokenHash(credentials.playerToken)) {
    fail(401, "invalid_player_auth", "These player credentials are not valid for the room.");
  }
  return player;
}

function publicPlayer(player: PlayerRow, hostPlayerId: string, now = Date.now()) {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat as 0 | 1,
    isHost: player.id === hostPlayerId,
    lastSeenAt: player.last_seen_at,
    isOnline: player.last_seen_at >= now - ONLINE_WINDOW_MS,
  };
}

function presenceVersionFor(players: PlayerRow[], now: number): number {
  let hash = 2166136261;
  for (const player of players) {
    // Presence should change only when a seat crosses online/offline, not on every
    // heartbeat. Hashing exact timestamps caused full image snapshots to be sent
    // repeatedly during otherwise unchanged drawing turns.
    const value = `${player.id}:${player.last_seen_at >= now - ONLINE_WINDOW_MS ? 1 : 0};`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function entryFromRow(row: EntryRow, players: PlayerRow[]) {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  return {
    id: row.id,
    ordinal: row.ordinal,
    round: row.round,
    authorPlayerId: row.author_player_id,
    authorName: players.find((player) => player.id === row.author_player_id)?.name ?? "Player",
    kind: row.kind,
    text: row.text_content,
    // Older releases stored an opaque-black placeholder for expired drawing
    // turns. Never expose any timeout row as a real drawing, including history
    // that already exists in production.
    imageData: metadata.expired === true ? null : row.image_data,
    metadata,
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
    expired: entry.metadata.expired === true,
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
  const actorSource = viewerPlayerId === internalTurn.actorPlayerId ? visibleSource : null;
  const sourceExpired = source
    ? "hidden" in source
      ? source.expired === true
      : source.metadata.expired === true
    : false;

  return {
    ...turn,
    kind,
    round: Math.max(1, state.round),
    playerId: turn.actorPlayerId,
    prompt:
      viewerPlayerId === turn.actorPlayerId && turn.suggestedPrompt
        ? turn.suggestedPrompt
        : actorSource?.text ?? undefined,
    clue: turn.clues?.at(-1),
    canAddClue:
      internalTurn.kind === "blind-drawing" &&
      internalTurn.promptAuthorId === viewerPlayerId &&
      internalTurn.actorPlayerId !== viewerPlayerId,
    duoBeat:
      state.round > 0 && state.round % 4 === 0
        ? DUO_BEATS[(state.round / 4 - 1) % DUO_BEATS.length]
        : undefined,
    previousText: actorSource?.text ?? undefined,
    previousImage: actorSource?.imageData ?? undefined,
    sourceExpired,
  };
}

async function snapshotFromRows(args: {
  database: D1Database;
  room: RoomRow;
  players: PlayerRow[];
  viewer: PlayerRow;
}) {
  const { database, room, players, viewer } = args;
  const serverNow = Date.now();
  const attributionPlayers = await allRoomPlayers(database, room.code);
  const settings = parsePersistedObject<RoomSettings>(room.settings_json, "room settings");
  const state = parsePersistedObject<StoredGameState>(room.game_state_json, "game state");
  const metadataResult = await database
    .prepare(`SELECT id, ordinal, round, author_player_id, kind, metadata_json,
      created_at, text_content IS NOT NULL AS has_text,
      image_data IS NOT NULL AS has_image
      FROM room_entries WHERE room_code = ? ORDER BY ordinal ASC`)
    .bind(room.code)
    .all<EntryMetaRow>();
  const turn = state.currentTurn;
  const sourceRow = turn?.sourceEntryId
    ? await database
        .prepare(`SELECT id, room_code, ordinal, room_version, round, author_player_id,
          kind, text_content, image_data, metadata_json, created_at
          FROM room_entries WHERE room_code = ? AND id = ?`)
        .bind(room.code, turn.sourceEntryId)
        .first<EntryRow>()
    : null;
  const source = sourceRow ? entryFromRow(sourceRow, attributionPlayers) : null;

  let currentSource: ReturnType<typeof entryFromRow> | ReturnType<typeof hiddenEntry> | null = source;
  if (source && turn?.kind === "blind-drawing" && viewer.id === turn.actorPlayerId) {
    currentSource = hiddenEntry(source);
  }
  if (source && turn?.kind === "memory-drawing" && Date.now() > (turn.revealUntil ?? 0)) {
    currentSource = hiddenEntry(source);
  }

  const status = room.status;
  const presenceVersion = presenceVersionFor(players, serverNow);
  let gallery: Array<ReturnType<typeof entryFromRow> & {
    playerId: string;
    playerName: string;
    rule?: string;
  }> = [];
  if (status === "finished") {
    const galleryRows = await database
      .prepare(`SELECT id, room_code, ordinal, room_version, round, author_player_id,
        kind, text_content, image_data, metadata_json, created_at
        FROM room_entries WHERE room_code = ? ORDER BY ordinal ASC`)
      .bind(room.code)
      .all<EntryRow>();
    gallery = galleryRows.results.map((row) => {
      const entry = entryFromRow(row, attributionPlayers);
      return {
        ...entry,
        playerId: entry.authorPlayerId,
        playerName: entry.authorName,
        rule: typeof entry.metadata.rule === "string" ? entry.metadata.rule : undefined,
      };
    });
  }
  const galleryMetadata = metadataResult.results.map((entry) => ({
    id: entry.id,
    ordinal: entry.ordinal,
    round: entry.round,
    playerId: entry.author_player_id,
    playerName:
      attributionPlayers.find((player) => player.id === entry.author_player_id)?.name ?? "Player",
    kind: entry.kind,
    rule: parseJson<Record<string, unknown>>(entry.metadata_json, {}).rule ?? undefined,
    hasText: Boolean(entry.has_text),
    hasImage: Boolean(entry.has_image),
    createdAt: entry.created_at,
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
    players: players.map((player) => publicPlayer(player, room.host_player_id, serverNow)),
    round: state.round,
    totalRounds: settings.rounds,
    turnNumber: state.turnNumber,
    turnIndex: Math.max(0, state.round - 1),
    totalTurns: settings.rounds,
    currentTurn: publicTurn(state, currentSource, viewer.id),
    currentSource,
    chainLength: metadataResult.results.length,
    gallery: status === "finished" ? gallery : [],
    galleryMetadata,
    serverNow,
    presenceVersion,
    lastActivityAt: room.last_activity_at,
    expiresAt: room.expires_at,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
  };
}

export async function getRoomSnapshot(
  rawCode: string,
  credentials: PlayerCredentials,
  sinceVersion?: number,
  sincePresenceVersion?: number,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  let room = await roomRow(database, code);
  const viewer = await authenticate(database, code, credentials);
  await touchPlayer(database, viewer.id);
  let players = await roomPlayers(database, code);
  const settings = parsePersistedObject<RoomSettings>(room.settings_json, "room settings");
  const state = parsePersistedObject<StoredGameState>(room.game_state_json, "game state");

  if (
    room.status === "playing" &&
    isTurnExpired(state, Date.now(), turnDeadlineGraceMs(settings, state))
  ) {
    try {
      await expireCurrentTurn({
        database,
        room,
        players,
        settings,
        state,
        now: Date.now(),
      });
    } catch (error) {
      if (!(error instanceof RoomServiceError) || error.errorCode !== "version_conflict") {
        throw error;
      }
    }
    room = await roomRow(database, code);
    players = await roomPlayers(database, code);
  }

  if (
    Number.isInteger(sinceVersion) &&
    sinceVersion === room.version &&
    Number.isInteger(sincePresenceVersion) &&
    sincePresenceVersion === presenceVersionFor(players, Date.now())
  ) {
    return { unchanged: true as const, code, version: room.version };
  }

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
  await cleanupExpiredRooms(database);
  const now = Date.now();
  const hostPlayerId = crypto.randomUUID();
  const playerToken = randomToken();
  const hash = await tokenHash(playerToken);
  const recoverySecret = randomToken();
  const recoveryHash = await tokenHash(recoverySecret);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode();
    try {
      await database.batch([
        database
          .prepare(`INSERT INTO rooms (
            code, host_player_id, status, settings_json, game_state_json,
            version, last_activity_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, 'waiting', ?, ?, 1, ?, ?, ?, ?)`)
          .bind(
            code,
            hostPlayerId,
            JSON.stringify(settings),
            JSON.stringify(waitingState()),
            now,
            nextExpiry("waiting", now),
            now,
            now,
          ),
        database
          .prepare(`INSERT INTO players (
            id, room_code, name, seat, token_hash, recovery_hash,
            joined_at, last_seen_at, left_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL)`)
          .bind(hostPlayerId, code, name, hash, recoveryHash, now, now),
      ]);

      const room = await roomRow(database, code);
      const players = await roomPlayers(database, code);
      const snapshot = await snapshotFromRows({ database, room, players, viewer: players[0] });
      return {
        room: snapshot,
        player: publicPlayer(players[0], hostPlayerId),
        playerId: hostPlayerId,
        playerToken,
        recoverySecret,
        recoveryToken: recoverySecret,
      };
    } catch (error) {
      const isCodeCollision = String(error).includes("UNIQUE constraint failed: rooms.code");
      if (!isCodeCollision || attempt === 7) throw error;
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
  const recoverySecret = randomToken();
  const recoveryHash = await tokenHash(recoverySecret);

  try {
    const result = await database.batch([
      database
        .prepare(`INSERT INTO players (
          id, room_code, name, seat, token_hash, recovery_hash,
          joined_at, last_seen_at, left_at
        )
          SELECT ?, room.code, ?,
            CASE WHEN EXISTS (
              SELECT 1 FROM players occupied
              WHERE occupied.room_code = room.code AND occupied.seat = 0
                AND occupied.left_at IS NULL
            ) THEN 1 ELSE 0 END,
            ?, ?, ?, ?, NULL FROM rooms room
          WHERE room.code = ? AND room.status = 'waiting'`)
        .bind(id, name, hash, recoveryHash, now, now, code),
      database
        .prepare(`UPDATE rooms SET version = version + 1, updated_at = ?,
          last_activity_at = ?, expires_at = ?
          WHERE code = ? AND status = 'waiting'
          AND EXISTS (SELECT 1 FROM players WHERE room_code = ? AND id = ?)`)
        .bind(now, now, nextExpiry("waiting", now), code, code, id),
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
    recoverySecret,
    recoveryToken: recoverySecret,
  };
}

export async function recoverRoomSession(
  rawCode: string,
  input: { playerId?: unknown; recoverySecret?: unknown; recoveryToken?: unknown },
) {
  const code = normalizeRoomCode(rawCode);
  const playerId = typeof input.playerId === "string" ? input.playerId.trim() : "";
  const recoverySecret =
    typeof input.recoverySecret === "string"
      ? input.recoverySecret.trim()
      : typeof input.recoveryToken === "string"
        ? input.recoveryToken.trim()
        : "";
  if (!playerId || !recoverySecret) {
    fail(400, "recovery_credentials_required", "Player ID and recovery secret are required.");
  }

  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const players = await roomPlayers(database, code);
  const player = players.find((candidate) => candidate.id === playerId);
  const suppliedHash = await tokenHash(recoverySecret);
  if (!player || !player.recovery_hash || player.recovery_hash !== suppliedHash) {
    fail(401, "invalid_recovery_auth", "The recovery credential is not valid for this player.");
  }

  const now = Date.now();
  const playerToken = randomToken();
  const newTokenHash = await tokenHash(playerToken);
  const nextRecoveryToken = randomToken();
  const nextRecoveryHash = await tokenHash(nextRecoveryToken);
  const rotation = await database
    .prepare(`UPDATE players SET token_hash = ?, recovery_hash = ?,
      last_seen_at = ?, left_at = NULL
      WHERE room_code = ? AND id = ? AND recovery_hash = ?`)
    .bind(newTokenHash, nextRecoveryHash, now, code, playerId, suppliedHash)
    .run();
  if (changes(rotation) !== 1) {
    fail(401, "invalid_recovery_auth", "The recovery credential has already been rotated.");
  }
  await database
    .prepare(`UPDATE rooms SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE code = ?`)
    .bind(now, now, nextExpiry(room.status, now), code)
    .run();

  const updatedRoom = await roomRow(database, code);
  const updatedPlayers = await roomPlayers(database, code);
  const viewer = updatedPlayers.find((candidate) => candidate.id === playerId);
  if (!viewer) fail(409, "recovery_conflict", "The player is no longer in this room.");
  return {
    room: await snapshotFromRows({ database, room: updatedRoom, players: updatedPlayers, viewer }),
    player: publicPlayer(viewer, updatedRoom.host_player_id),
    playerId,
    playerToken,
    recoverySecret: nextRecoveryToken,
    recoveryToken: nextRecoveryToken,
  };
}

export async function heartbeatRoom(
  rawCode: string,
  credentials: PlayerCredentials,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const viewer = await authenticate(database, code, credentials);
  const now = Date.now();
  await touchPlayer(database, viewer.id, now, true);
  await database
    .prepare(`UPDATE rooms SET updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE code = ?`)
    .bind(now, now, nextExpiry(room.status, now), code)
    .run();
  const updatedRoom = await roomRow(database, code);
  const players = await roomPlayers(database, code);
  const updatedViewer = players.find((player) => player.id === viewer.id) ?? viewer;
  return {
    room: await snapshotFromRows({
      database,
      room: updatedRoom,
      players,
      viewer: updatedViewer,
    }),
  };
}

export async function leaveRoom(
  rawCode: string,
  credentials: PlayerCredentials,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const actor = await authenticateLeaveReplay(database, code, credentials);
  const players = await roomPlayers(database, code);
  const remaining = players.find((player) => player.id !== actor.id);

  if (actor.left_at !== null) {
    if (!remaining) {
      return { left: true as const, roomDeleted: true as const, code };
    }
    return {
      left: true as const,
      roomDeleted: false as const,
      code,
      hostPlayerId: room.host_player_id,
      status: room.status,
    };
  }

  const now = Date.now();
  const roomDeleted = !remaining;
  const nextStatus: RoomStatus = room.status === "playing" || roomDeleted
    ? "finished"
    : room.status;
  const currentState = parsePersistedObject<StoredGameState>(room.game_state_json, "game state");
  const nextState = room.status === "playing" || roomDeleted
    ? { ...currentState, currentTurn: null }
    : currentState;
  const nextHostPlayerId = remaining && room.host_player_id === actor.id
    ? remaining.id
    : room.host_player_id;
  const expiry = roomDeleted
    ? now + WAITING_RETENTION_MS
    : nextExpiry(nextStatus, now);
  const result = await database.batch([
    database
      .prepare(`UPDATE players SET left_at = ?, last_seen_at = ?
        WHERE room_code = ? AND id = ? AND left_at IS NULL
        AND EXISTS (
          SELECT 1 FROM rooms
          WHERE rooms.code = ? AND rooms.version = ?
        )`)
      .bind(now, now, code, actor.id, code, room.version),
    database
      .prepare(`UPDATE rooms SET host_player_id = ?, status = ?, game_state_json = ?,
        version = version + 1, updated_at = ?, last_activity_at = ?, expires_at = ?
        WHERE code = ? AND version = ?`)
      .bind(
        nextHostPlayerId,
        nextStatus,
        JSON.stringify(nextState),
        now,
        now,
        expiry,
        code,
        room.version,
      ),
  ]);
  if (changes(result[0]) !== 1 || changes(result[1]) !== 1) {
    const replayActor = await authenticateLeaveReplay(database, code, credentials);
    if (replayActor.left_at !== null) {
      const replayRoom = await roomRow(database, code);
      const replayPlayers = await roomPlayers(database, code);
      const replayRemaining = replayPlayers.find((player) => player.id !== actor.id);
      return replayRemaining
        ? {
            left: true as const,
            roomDeleted: false as const,
            code,
            hostPlayerId: replayRoom.host_player_id,
            status: replayRoom.status,
          }
        : { left: true as const, roomDeleted: true as const, code };
    }
    fail(409, "version_conflict", "The room changed while the player was leaving.");
  }
  if (roomDeleted) {
    return { left: true as const, roomDeleted: true as const, code };
  }
  return {
    left: true as const,
    roomDeleted: false as const,
    code,
    hostPlayerId: nextHostPlayerId,
    status: nextStatus,
  };
}

export async function deleteRoom(
  rawCode: string,
  credentials: PlayerCredentials,
) {
  const code = normalizeRoomCode(rawCode);
  const database = await roomDatabase();
  const room = await roomRow(database, code);
  const actor = await authenticate(database, code, credentials);
  requireHost(room, actor);
  await deleteRoomData(database, code);
  return { deleted: true as const, code };
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
  try {
    return validateImageDataUrl(value);
  } catch (error) {
    if (error instanceof ImageDataUrlValidationError) {
      if (error.code === "too_large") {
        fail(413, "drawing_too_large", "The drawing is too large. Export a smaller canvas image.");
      }
      if (error.code === "invalid_dimensions") {
        fail(400, "invalid_drawing_dimensions", error.message);
      }
      fail(400, "invalid_drawing", error.message);
    }
    throw error;
  }
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
  const status = args.status ?? room.status;
  const now = Date.now();
  const result = await database
    .prepare(`UPDATE rooms SET status = ?, settings_json = ?, game_state_json = ?,
      version = version + 1, updated_at = ?, last_activity_at = ?, expires_at = ?
      WHERE code = ? AND version = ?`)
    .bind(
      status,
      JSON.stringify(args.settings ?? parsePersistedObject<RoomSettings>(room.settings_json, "room settings")),
      JSON.stringify(state),
      now,
      now,
      nextExpiry(status, now),
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
  const now = Date.now();
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
        version = version + 1, updated_at = ?, last_activity_at = ?, expires_at = ?
        WHERE code = ? AND version = ? AND status = 'playing'`)
      .bind(
        status,
        JSON.stringify(state),
        now,
        now,
        nextExpiry(status, now),
        room.code,
        version,
      ),
  ]);

  if (changes(result[0]) !== 1 || changes(result[1]) !== 1) {
    fail(409, "version_conflict", "The room changed; refresh its state and try again.");
  }
}

async function touchPlayer(
  database: D1Database,
  playerId: string,
  now = Date.now(),
  force = false,
): Promise<boolean> {
  const result = await database
    .prepare(`UPDATE players SET last_seen_at = ?
      WHERE id = ? AND left_at IS NULL AND (? OR last_seen_at < ?)`)
    .bind(now, playerId, force ? 1 : 0, now - PRESENCE_WRITE_INTERVAL_MS)
    .run();
  return changes(result) === 1;
}

async function expireCurrentTurn(args: {
  database: D1Database;
  room: RoomRow;
  players: PlayerRow[];
  settings: RoomSettings;
  state: StoredGameState;
  now: number;
  force?: boolean;
}): Promise<boolean> {
  const { database, room, players, settings, state, now, force = false } = args;
  const turn = state.currentTurn;
  if (room.status !== "playing" || !turn) return false;
  const graceMs = turnDeadlineGraceMs(settings, state);
  if (!isTurnExpired(state, now, graceMs)) {
    if (!force) return false;
    fail(409, "turn_not_expired", "This turn still has time remaining.", {
      serverNow: now,
      deadlineAt: turn.deadlineAt,
      expiresAt: turn.deadlineAt + graceMs,
    });
  }

  const entryId = crypto.randomUUID();
  const textKind = expectedTextKind(turn.kind);
  let advanced: ReturnType<typeof advanceAfterText> | ReturnType<typeof advanceAfterDrawing>;
  let textContent: string | null = null;
  let imageData: string | null = null;
  let entryKind: string;

  if (textKind) {
    textContent = textKind === "prompt"
      ? "A mysterious surprise appeared"
      : textKind === "caption"
        ? "Meanwhile, time slipped away."
        : "Time ran out";
    advanced = advanceAfterText({
      settings,
      state,
      players: toGamePlayers(players),
      actorPlayerId: turn.actorPlayerId,
      entryId,
      text: textContent,
      now,
    });
    entryKind = textKind;
  } else if (isDrawingTurn(turn.kind)) {
    // A timeout is an event, not a drawing. The former one-pixel placeholder
    // was opaque black and was enlarged as if a player had submitted it.
    imageData = null;
    advanced = advanceAfterDrawing({
      settings,
      state,
      players: toGamePlayers(players),
      actorPlayerId: turn.actorPlayerId,
      entryId,
      now,
    });
    entryKind = turn.kind === "seed-drawing" ? "drawing" : turn.kind;
  } else {
    return false;
  }

  await commitEntry({
    database,
    room,
    expectedVersion: room.version,
    state: advanced.state,
    status: advanced.finished ? "finished" : "playing",
    entry: {
      id: entryId,
      round: state.round,
      authorPlayerId: turn.actorPlayerId,
      kind: entryKind,
      textContent,
      imageData,
      metadata: {
        expired: true,
        sourceEntryId: turn.sourceEntryId ?? null,
        rule: turn.rule ?? null,
      },
      createdAt: now,
    },
  });
  return true;
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
        version = version + 1, updated_at = ?, last_activity_at = ?, expires_at = ?
        WHERE code = ? AND version = ?`)
      .bind(
        JSON.stringify(waitingState()),
        now,
        now,
        nextExpiry("waiting", now),
        room.code,
        version,
      ),
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
  const actionType = typeof payload.type === "string" ? payload.type : "";
  if (actionType === "heartbeat") return heartbeatRoom(code, credentials);
  if (actionType === "leave_room") return leaveRoom(code, credentials);

  const database = await roomDatabase();
  let room = await roomRow(database, code);
  const actor = await authenticate(database, code, credentials);
  const now = Date.now();
  await touchPlayer(database, actor.id, now);

  let players = await roomPlayers(database, code);
  const settings = parsePersistedObject<RoomSettings>(room.settings_json, "room settings");
  const state = parsePersistedObject<StoredGameState>(room.game_state_json, "game state");

  if (actionType === "expire_turn") {
    expectedVersion(payload, room.version);
    const expired = await expireCurrentTurn({
      database,
      room,
      players,
      settings,
      state,
      now,
      force: true,
    });
    if (!expired) fail(409, "no_active_turn", "There is no active turn to expire.");
    room = await roomRow(database, code);
    players = await roomPlayers(database, code);
    return {
      expired: true as const,
      room: await snapshotFromRows({ database, room, players, viewer: actor }),
    };
  }

  if (
    room.status === "playing" &&
    isTurnExpired(state, now, turnDeadlineGraceMs(settings, state))
  ) {
    try {
      await expireCurrentTurn({ database, room, players, settings, state, now });
    } catch (error) {
      if (!(error instanceof RoomServiceError) || error.errorCode !== "version_conflict") {
        throw error;
      }
    }
    room = await roomRow(database, code);
    fail(409, "turn_expired", "The deadline passed, so the turn advanced without the late content.", {
      currentVersion: room.version,
      serverNow: now,
    });
  }

  const version = expectedVersion(payload, room.version);

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
    if (room.status !== "waiting") {
      fail(409, "reset_locked", "A room can only be reset while it is in the lobby.");
    }
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
