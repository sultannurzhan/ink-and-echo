export const GAME_MODE_IDS = [
  "classic-chain",
  "memory-drift",
  "blind-prompt",
  "remix-mode",
  "speed-chaos",
  "story-canvas",
  "guess-evolution",
] as const;

export type GameModeId = (typeof GAME_MODE_IDS)[number];

export type PlayerSlot = 0 | 1;

export type CanvasPresetId = "square" | "landscape" | "portrait";

export interface CanvasPreset {
  id: CanvasPresetId;
  label: string;
  width: number;
  height: number;
  description: string;
}

export interface GameSettings {
  mode: GameModeId;
  roundCount: number;
  timerSeconds: number;
  randomPrompts: boolean;
  canvasPreset: CanvasPresetId;
}

/** Accepts canonical names plus the compact room-form aliases used by the UI/API. */
export interface GameSettingsInput {
  mode?: GameModeId | "remix";
  roundCount?: number;
  rounds?: number;
  timerSeconds?: number;
  timer?: number;
  randomPrompts?: boolean;
  canvasPreset?: CanvasPresetId;
  canvasSize?: CanvasPresetId | "classic" | "wide";
}

export interface GameModeMetadata {
  id: GameModeId;
  name: string;
  eyebrow: string;
  icon: string;
  description: string;
  howItFeels: string;
  rhythm: string;
  accent: string;
  accentSoft: string;
  recommendedRounds: number;
  defaultTimerSeconds: number;
  supportsRandomPrompts: boolean;
  highlights: readonly string[];
}

export type TurnAction =
  | "write_prompt"
  | "draw"
  | "guess"
  | "memory_draw"
  | "blind_draw"
  | "remix_draw"
  | "speed_draw"
  | "speed_guess"
  | "story_draw"
  | "story_caption"
  | "evolution_draw"
  | "evolution_guess";

export type ArtifactKind = "prompt" | "drawing" | "guess" | "caption";

export type TurnSourceRule =
  | "none"
  | "previous_artifact"
  | "latest_drawing"
  | "latest_text"
  | "memory_flash"
  | "clues_only";

export interface PromptCard {
  id: string;
  text: string;
  category: string;
  mood: string;
  setting: string;
  ingredients: readonly [string, string];
}

export interface ClueBeat {
  id: string;
  revealAtElapsedSeconds: number;
  label: string;
  text: string;
}

export type RemixIntensity = 1 | 2 | 3;

export interface RemixRule {
  id: string;
  icon: string;
  title: string;
  instruction: string;
  intensity: RemixIntensity;
  tag: "mood" | "character" | "plot" | "style" | "mystery";
}

export interface MemoryTwist {
  id: string;
  icon: string;
  title: string;
  instruction: string;
  intensity: RemixIntensity;
}

export interface StoryBeat {
  id: string;
  label: string;
  instruction: string;
}

export interface DuoBeat {
  id: string;
  icon: string;
  label: string;
  invitation: string;
}

export interface TurnPlanItem {
  id: string;
  roundNumber: number;
  totalRounds: number;
  actorIndex: PlayerSlot;
  action: TurnAction;
  artifactKind: ArtifactKind;
  sourceRule: TurnSourceRule;
  phaseLabel: string;
  headline: string;
  instruction: string;
  timerSeconds: number;
  previewSeconds?: number;
  promptCard?: PromptCard;
  /** Kept server-side. Use `redactTurnForPlayer` before broadcasting a turn. */
  secretPrompt?: string;
  clueSchedule?: readonly ClueBeat[];
  remixRule?: RemixRule;
  memoryTwist?: MemoryTwist;
  storyBeat?: StoryBeat;
  duoBeat?: DuoBeat;
  isFinale: boolean;
}

export interface TurnView extends Omit<TurnPlanItem, "secretPrompt" | "clueSchedule"> {
  visiblePrompt?: string;
  availableClues: readonly ClueBeat[];
}

export interface Player {
  id: string;
  name: string;
  avatar: string;
  slot: PlayerSlot;
  isHost: boolean;
  connected: boolean;
}

export type PlayerPair = readonly [Player, Player];

export interface DrawingSnapshot {
  /** A compact PNG/WebP data URL for the local-first MVP, or an object URL later. */
  dataUrl: string;
  width: number;
  height: number;
  backgroundColor: string;
  strokeCount?: number;
}

interface ArtifactBase {
  id: string;
  turnId: string;
  roundNumber: number;
  authorId: string;
  createdAt?: string;
}

export interface PromptArtifact extends ArtifactBase {
  kind: "prompt";
  text: string;
  /** Optional authored ladder used by manual Blind Prompt rounds. */
  clues?: readonly string[];
}

export interface DrawingArtifact extends ArtifactBase {
  kind: "drawing";
  snapshot: DrawingSnapshot;
}

export interface GuessArtifact extends ArtifactBase {
  kind: "guess";
  text: string;
}

export interface CaptionArtifact extends ArtifactBase {
  kind: "caption";
  text: string;
}

export type GameArtifact =
  | PromptArtifact
  | DrawingArtifact
  | GuessArtifact
  | CaptionArtifact;

export type TurnArtifactInput =
  | { kind: "prompt"; text: string; clues?: readonly string[] }
  | { kind: "drawing"; snapshot: DrawingSnapshot }
  | { kind: "guess"; text: string }
  | { kind: "caption"; text: string };

export interface TurnSubmission {
  actorId: string;
  artifact: TurnArtifactInput;
  createdAt?: string;
}

export type GameStatus = "playing" | "gallery";

export interface GameState {
  id: string;
  seed: string;
  status: GameStatus;
  settings: GameSettings;
  players: PlayerPair;
  turns: readonly TurnPlanItem[];
  currentTurnIndex: number;
  artifacts: readonly GameArtifact[];
  startedAt?: string;
  completedAt?: string;
}

export type GameTransition =
  | { ok: true; state: GameState; completedTurn: TurnPlanItem }
  | { ok: false; state: GameState; error: string };

export interface GalleryEntry {
  turn: TurnPlanItem;
  artifact?: GameArtifact;
  author: Player;
}

export interface TurnPlanOptions {
  seed?: string;
  starterIndex?: PlayerSlot;
}

export interface CreateGameOptions extends TurnPlanOptions {
  gameId?: string;
  startedAt?: string;
}
