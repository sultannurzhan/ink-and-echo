export type View = "landing" | "create" | "join" | "lobby" | "game" | "gallery";
export type ModeId =
  | "classic-chain"
  | "memory-drift"
  | "blind-prompt"
  | "remix-mode"
  | "speed-chaos"
  | "story-canvas"
  | "guess-evolution";

export type Settings = {
  mode: ModeId;
  rounds: number;
  timerSeconds: number;
  randomPrompts: boolean;
  canvasSize: "square" | "classic" | "wide";
};

export type Player = {
  id: string;
  name: string;
  isHost?: boolean;
  isOnline?: boolean;
  lastSeenAt?: number;
};
export type GalleryEntry = {
  id?: string;
  round: number;
  kind: string;
  playerId?: string;
  playerName?: string;
  text?: string;
  imageData?: string;
  rule?: string;
  metadata?: {
    expired?: boolean;
    [key: string]: unknown;
  };
};
export type CurrentTurn = {
  kind: "prompt" | "guess" | "caption" | "draw" | "memory" | "remix" | "blind-draw";
  round: number;
  playerId?: string;
  instruction?: string;
  prompt?: string;
  clue?: string;
  previousText?: string;
  previousImage?: string;
  rule?: string;
  duoBeat?: string;
  deadlineAt?: number;
  revealUntil?: number;
  sourceEntryId?: string | null;
  sourceExpired?: boolean;
  canAddClue?: boolean;
};
export type Room = {
  code: string;
  localGameId?: string;
  localState?: import("../server/room-game").StoredGameState;
  archiveMode?: string;
  phase: "lobby" | "playing" | "gallery" | "finished";
  version: number;
  hostPlayerId?: string;
  activePlayerId?: string;
  turnIndex?: number;
  totalTurns?: number;
  turnNumber?: number;
  presenceVersion?: number;
  serverNow?: number;
  expiresAt?: number;
  settings: Settings;
  players: Player[];
  currentTurn?: CurrentTurn | null;
  gallery?: GalleryEntry[];
};
export type Session = {
  room: Room;
  playerId: string;
  playerToken: string;
  recoveryToken?: string;
  playerName?: string;
};
