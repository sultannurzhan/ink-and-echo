import {
  BLIND_CLUE_LADDERS,
  CANVAS_PRESETS,
  DUO_BEATS,
  GAME_MODE_BY_ID,
  MEMORY_TWISTS,
  PROMPT_CARDS,
  REMIX_RULES,
  STORY_BEATS,
} from "./content";
import {
  GAME_MODE_IDS,
  type ArtifactKind,
  type ClueBeat,
  type CreateGameOptions,
  type DuoBeat,
  type GalleryEntry,
  type GameArtifact,
  type GameModeId,
  type GameSettings,
  type GameSettingsInput,
  type GameState,
  type GameTransition,
  type MemoryTwist,
  type PlayerPair,
  type PlayerSlot,
  type PromptArtifact,
  type PromptCard,
  type RemixIntensity,
  type RemixRule,
  type StoryBeat,
  type TurnAction,
  type TurnArtifactInput,
  type TurnPlanItem,
  type TurnPlanOptions,
  type TurnSourceRule,
  type TurnSubmission,
  type TurnView,
} from "./types";

export const GAME_LIMITS = {
  minRounds: 3,
  maxRounds: 20,
  minTimerSeconds: 10,
  maxTimerSeconds: 180,
  speedChaosMaxSeconds: 25,
} as const;

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  mode: "classic-chain",
  roundCount: GAME_MODE_BY_ID["classic-chain"].recommendedRounds,
  timerSeconds: GAME_MODE_BY_ID["classic-chain"].defaultTimerSeconds,
  randomPrompts: true,
  canvasPreset: "landscape",
};

const DRAW_ACTIONS: readonly TurnAction[] = [
  "draw",
  "memory_draw",
  "blind_draw",
  "remix_draw",
  "speed_draw",
  "story_draw",
  "evolution_draw",
];

const GUESS_ACTIONS: readonly TurnAction[] = ["guess", "speed_guess", "evolution_guess"];

interface TurnSpec {
  action: TurnAction;
  sourceRule: TurnSourceRule;
  phaseLabel: string;
  headline: string;
  instruction: string;
  timerSeconds?: number;
  previewSeconds?: number;
  promptCard?: PromptCard;
  secretPrompt?: string;
  clueSchedule?: readonly ClueBeat[];
  remixRule?: RemixRule;
  memoryTwist?: MemoryTwist;
  storyBeat?: StoryBeat;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function isMode(value: unknown): value is GameModeId {
  return typeof value === "string" && GAME_MODE_IDS.includes(value as GameModeId);
}

function isCanvasPreset(value: unknown): value is GameSettings["canvasPreset"] {
  return CANVAS_PRESETS.some((preset) => preset.id === value);
}

/**
 * Sanitizes URL/form values and applies mode-aware timer defaults. It is safe to
 * call on already-normalized settings.
 */
export function normalizeGameSettings(input: GameSettingsInput = {}): GameSettings {
  const requestedMode = input.mode === "remix" ? "remix-mode" : input.mode;
  const mode = isMode(requestedMode) ? requestedMode : DEFAULT_GAME_SETTINGS.mode;
  const metadata = GAME_MODE_BY_ID[mode];
  const timerMax = mode === "speed-chaos"
    ? GAME_LIMITS.speedChaosMaxSeconds
    : GAME_LIMITS.maxTimerSeconds;
  const requestedCanvas = input.canvasPreset ?? input.canvasSize;
  const canonicalCanvas = requestedCanvas === "classic" || requestedCanvas === "wide"
    ? "landscape"
    : requestedCanvas;

  return {
    mode,
    roundCount: clampInteger(
      input.roundCount ?? input.rounds,
      metadata.recommendedRounds,
      GAME_LIMITS.minRounds,
      GAME_LIMITS.maxRounds,
    ),
    timerSeconds: clampInteger(
      input.timerSeconds ?? input.timer,
      metadata.defaultTimerSeconds,
      GAME_LIMITS.minTimerSeconds,
      timerMax,
    ),
    randomPrompts: input.randomPrompts ?? DEFAULT_GAME_SETTINGS.randomPrompts,
    canvasPreset: isCanvasPreset(canonicalCanvas)
      ? canonicalCanvas
      : DEFAULT_GAME_SETTINGS.canvasPreset,
  };
}

/** FNV-1a-style string hash used only for deterministic game content, not security. */
export function hashGameSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A tiny deterministic PRNG so two clients can build the same decks from one seed. */
export function createSeededRandom(seed: string): () => number {
  let state = hashGameSeed(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function artifactKindForAction(action: TurnAction): ArtifactKind {
  if (DRAW_ACTIONS.includes(action)) return "drawing";
  if (GUESS_ACTIONS.includes(action)) return "guess";
  if (action === "story_caption") return "caption";
  return "prompt";
}

function alternateActor(index: number, starterIndex: PlayerSlot): PlayerSlot {
  return ((starterIndex + index) % 2) as PlayerSlot;
}

function intensityFor(index: number, total: number): RemixIntensity {
  const progress = total <= 1 ? 1 : index / (total - 1);
  if (progress >= 0.68) return 3;
  if (progress >= 0.3) return 2;
  return 1;
}

function progressivePick<T extends { intensity: RemixIntensity }>(
  items: readonly T[],
  index: number,
  total: number,
  random: () => number,
): T {
  const intensity = intensityFor(index, total);
  const matching = items.filter((item) => item.intensity === intensity);
  return matching[(index + Math.floor(random() * matching.length)) % matching.length];
}

function duoBeatFor(index: number, total: number): DuoBeat | undefined {
  if (index === total - 1) return DUO_BEATS[3];
  if (index === Math.floor(total / 2)) return DUO_BEATS[1];
  if (index > 1 && index % 4 === 0) return DUO_BEATS[0];
  if (index > 0 && index % 5 === 0) return DUO_BEATS[2];
  return undefined;
}

function storyBeatFor(index: number, total: number): StoryBeat {
  if (index === total - 1) return STORY_BEATS[STORY_BEATS.length - 1];
  const progress = total <= 1 ? 0 : index / (total - 1);
  const beatIndex = Math.min(
    STORY_BEATS.length - 2,
    Math.floor(progress * (STORY_BEATS.length - 1)),
  );
  return STORY_BEATS[beatIndex];
}

function makeTurn(
  settings: GameSettings,
  index: number,
  actorIndex: PlayerSlot,
  idPrefix: string,
  spec: TurnSpec,
): TurnPlanItem {
  return {
    id: `${idPrefix}-r${String(index + 1).padStart(2, "0")}`,
    roundNumber: index + 1,
    totalRounds: settings.roundCount,
    actorIndex,
    action: spec.action,
    artifactKind: artifactKindForAction(spec.action),
    sourceRule: spec.sourceRule,
    phaseLabel: spec.phaseLabel,
    headline: spec.headline,
    instruction: spec.instruction,
    timerSeconds: spec.timerSeconds ?? settings.timerSeconds,
    previewSeconds: spec.previewSeconds,
    promptCard: spec.promptCard,
    secretPrompt: spec.secretPrompt,
    clueSchedule: spec.clueSchedule,
    remixRule: spec.remixRule,
    memoryTwist: spec.memoryTwist,
    storyBeat: spec.storyBeat,
    duoBeat: duoBeatFor(index, settings.roundCount),
    isFinale: index === settings.roundCount - 1,
  };
}

/** Creates four clues that get more concrete without revealing the full prompt. */
export function buildBlindClueSchedule(
  card: PromptCard,
  timerSeconds: number,
): readonly ClueBeat[] {
  const revealTimes = [
    0,
    Math.max(3, Math.round(timerSeconds * 0.25)),
    Math.max(6, Math.round(timerSeconds * 0.5)),
    Math.max(9, Math.min(timerSeconds - 3, Math.round(timerSeconds * 0.74))),
  ];
  const values = [
    card.category,
    card.mood,
    card.setting,
    `${card.ingredients[0]} + ${card.ingredients[1]}`,
  ];

  return BLIND_CLUE_LADDERS.map((stage, index) => ({
    id: `${card.id}-clue-${index + 1}`,
    revealAtElapsedSeconds: revealTimes[index],
    label: stage.label,
    text: values[index],
  }));
}

export function buildManualClueSchedule(
  clues: readonly string[],
  timerSeconds: number,
): readonly ClueBeat[] {
  const cleaned = clues.map((clue) => clue.trim()).filter(Boolean).slice(0, 4);
  const interval = Math.max(3, Math.floor((timerSeconds - 3) / Math.max(cleaned.length, 1)));
  return cleaned.map((text, index) => ({
    id: `manual-clue-${index + 1}`,
    revealAtElapsedSeconds: index * interval,
    label: BLIND_CLUE_LADDERS[index]?.label ?? `Clue ${index + 1}`,
    text,
  }));
}

export function getAvailableClues(
  clueSchedule: readonly ClueBeat[] | undefined,
  elapsedSeconds: number,
): readonly ClueBeat[] {
  return (clueSchedule ?? []).filter(
    (clue) => elapsedSeconds >= clue.revealAtElapsedSeconds,
  );
}

function classicTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
): TurnSpec {
  const phase = index % 3;
  const card = promptDeck[Math.floor(index / 3) % promptDeck.length];
  if (phase === 0) {
    return {
      action: "write_prompt",
      sourceRule: "none",
      phaseLabel: "Plant the idea",
      headline: "Write a drawable little sentence",
      instruction: settings.randomPrompts
        ? "Use the prompt spark, tweak it, or replace it with an inside joke. Specific beats clever."
        : "Give your partner a clear subject, an action, and one delightful complication.",
      promptCard: settings.randomPrompts ? card : undefined,
    };
  }
  if (phase === 1) {
    return {
      action: "draw",
      sourceRule: "previous_artifact",
      phaseLabel: "Pass it in pictures",
      headline: "Draw exactly what landed with you",
      instruction: "No explaining and no perfection required. Make the important nouns unmistakable.",
    };
  }
  return {
    action: "guess",
    sourceRule: "latest_drawing",
    phaseLabel: "Name that doodle",
    headline: "What do you think this was?",
    instruction: "Write the most specific guess the drawing supports. Confidence is funnier than caution.",
  };
}

function memoryTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
  random: () => number,
): TurnSpec {
  if (index === 0) {
    return {
      action: "draw",
      sourceRule: "none",
      phaseLabel: "The original",
      headline: "Make a memorable first doodle",
      instruction: settings.randomPrompts
        ? "Use the prompt as a springboard. Bold shapes will survive the memory journey best."
        : "Invent a simple scene with three memorable details for your partner to inherit.",
      promptCard: settings.randomPrompts ? promptDeck[0] : undefined,
    };
  }

  const twist = progressivePick(MEMORY_TWISTS, index, settings.roundCount, random);
  const progress = index / Math.max(settings.roundCount - 1, 1);
  const previewSeconds = Math.max(2, Math.round(8 - progress * 5));
  return {
    action: "memory_draw",
    sourceRule: "memory_flash",
    phaseLabel: `${previewSeconds}-second memory`,
    headline: twist.title,
    instruction: `${twist.instruction} The reference disappears before your pencil starts.`,
    previewSeconds,
    memoryTwist: twist,
  };
}

function blindTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
): TurnSpec {
  const card = promptDeck[index % promptDeck.length];
  if (!settings.randomPrompts && index % 2 === 0) {
    return {
      action: "write_prompt",
      sourceRule: "none",
      phaseLabel: "Secret setup",
      headline: "Write the target and four sideways clues",
      instruction:
        "Your partner will not see the target. Start broad, then make each clue a little more useful.",
    };
  }

  if (!settings.randomPrompts) {
    return {
      action: "blind_draw",
      sourceRule: "clues_only",
      phaseLabel: "Clues, not answers",
      headline: "Draw what the clues might mean",
      instruction: "Commit early. A new clue will arrive as the timer runs, but the full target stays hidden.",
    };
  }

  return {
    action: "blind_draw",
    sourceRule: "clues_only",
    phaseLabel: "Clues, not answers",
    headline: "Draw what the clues might mean",
    instruction: "Commit early. A new clue will arrive as the timer runs, but the full target stays hidden.",
    secretPrompt: card.text,
    clueSchedule: buildBlindClueSchedule(card, settings.timerSeconds),
  };
}

function remixTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
  random: () => number,
): TurnSpec {
  if (index === 0) {
    return {
      action: "draw",
      sourceRule: "none",
      phaseLabel: "Source material",
      headline: "Create the doodle everything will inherit",
      instruction: settings.randomPrompts
        ? "Draw the spark with a few clear details worth remixing later."
        : "Start any scene you would be delighted to see your partner transform.",
      promptCard: settings.randomPrompts ? promptDeck[0] : undefined,
    };
  }
  const rule = progressivePick(REMIX_RULES, index, settings.roundCount, random);
  return {
    action: "remix_draw",
    sourceRule: "latest_drawing",
    phaseLabel: `Remix card · ${rule.icon}`,
    headline: rule.title,
    instruction: `${rule.instruction} Preserve at least one recognizable detail from the previous version.`,
    remixRule: rule,
  };
}

function speedTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
): TurnSpec {
  if (index % 2 === 0) {
    const card = promptDeck[Math.floor(index / 2) % promptDeck.length];
    return {
      action: "speed_draw",
      sourceRule: "none",
      phaseLabel: "Doodle sprint",
      headline: settings.randomPrompts ? card.text : "Draw a ridiculous idea—now!",
      instruction: "Big shapes first. One recognizable detail is a complete victory.",
      promptCard: settings.randomPrompts ? card : undefined,
      timerSeconds: Math.min(settings.timerSeconds, GAME_LIMITS.speedChaosMaxSeconds),
    };
  }
  return {
    action: "speed_guess",
    sourceRule: "latest_drawing",
    phaseLabel: "Snap guess",
    headline: "First thought, best thought",
    instruction: "Type the first specific interpretation that makes you laugh. No forensic analysis.",
    timerSeconds: Math.max(10, Math.min(15, settings.timerSeconds)),
  };
}

function storyTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
): TurnSpec {
  const beat = storyBeatFor(index, settings.roundCount);
  if (index % 2 === 0) {
    return {
      action: "story_draw",
      sourceRule: index === 0 ? "none" : "latest_text",
      phaseLabel: beat.label,
      headline: index === 0 ? "Open on a scene" : "Draw the next panel",
      instruction: `${beat.instruction} Leave one visual question for your partner.`,
      promptCard: index === 0 && settings.randomPrompts ? promptDeck[0] : undefined,
      storyBeat: beat,
    };
  }
  return {
    action: "story_caption",
    sourceRule: "latest_drawing",
    phaseLabel: beat.label,
    headline: "Caption what just happened",
    instruction: `${beat.instruction} Keep it to one or two punchy sentences.`,
    storyBeat: beat,
  };
}

function evolutionTurn(
  settings: GameSettings,
  index: number,
  promptDeck: readonly PromptCard[],
): TurnSpec {
  if (index === 0) {
    return {
      action: "write_prompt",
      sourceRule: "none",
      phaseLabel: "The ancestor",
      headline: "Start one idea worth mutating",
      instruction: settings.randomPrompts
        ? "Adopt or edit the prompt spark. This is the last time anyone sees the original."
        : "Write one vivid sentence. Every later round will know only the latest interpretation.",
      promptCard: settings.randomPrompts ? promptDeck[0] : undefined,
    };
  }
  if (index % 2 === 1) {
    return {
      action: "evolution_draw",
      sourceRule: "latest_text",
      phaseLabel: `Generation ${index}`,
      headline: "Draw only the latest words",
      instruction: "Do not repair the family tree from memory. Treat the latest text as absolute truth.",
    };
  }
  return {
    action: "evolution_guess",
    sourceRule: "latest_drawing",
    phaseLabel: `Generation ${index}`,
    headline: "Name this new species",
    instruction: "Describe only what is visible. Your sentence becomes the next artist’s entire world.",
  };
}

/**
 * Builds the complete deterministic turn schedule for any supported mode.
 * A "round" is one creative handoff, so every plan contains exactly roundCount items.
 */
export function createTurnPlan(
  settingsInput: GameSettingsInput = {},
  options: TurnPlanOptions = {},
): readonly TurnPlanItem[] {
  const settings = normalizeGameSettings(settingsInput);
  const seed = options.seed ?? `${settings.mode}:${settings.roundCount}:${settings.timerSeconds}`;
  const starterIndex = options.starterIndex ?? 0;
  const random = createSeededRandom(seed);
  const promptDeck = seededShuffle(PROMPT_CARDS, random);
  const idPrefix = `${settings.mode}-${hashGameSeed(seed).toString(36)}`;

  return Array.from({ length: settings.roundCount }, (_, index) => {
    const actorIndex = alternateActor(index, starterIndex);
    let spec: TurnSpec;
    switch (settings.mode) {
      case "memory-drift":
        spec = memoryTurn(settings, index, promptDeck, random);
        break;
      case "blind-prompt":
        spec = blindTurn(settings, index, promptDeck);
        break;
      case "remix-mode":
        spec = remixTurn(settings, index, promptDeck, random);
        break;
      case "speed-chaos":
        spec = speedTurn(settings, index, promptDeck);
        break;
      case "story-canvas":
        spec = storyTurn(settings, index, promptDeck);
        break;
      case "guess-evolution":
        spec = evolutionTurn(settings, index, promptDeck);
        break;
      case "classic-chain":
      default:
        spec = classicTurn(settings, index, promptDeck);
        break;
    }
    return makeTurn(settings, index, actorIndex, idPrefix, spec);
  });
}

export function getModeMetadata(mode: GameModeId) {
  return GAME_MODE_BY_ID[mode];
}

export function getActiveTurn(state: GameState): TurnPlanItem | undefined {
  return state.status === "playing" ? state.turns[state.currentTurnIndex] : undefined;
}

export function getRoundProgress(state: GameState) {
  const total = state.turns.length;
  const completed = Math.min(state.artifacts.length, total);
  return {
    completed,
    total,
    current: state.status === "gallery" ? total : Math.min(state.currentTurnIndex + 1, total),
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

/** Finds only the artifact a turn is allowed to inherit. */
export function getVisibleSource(
  state: Pick<GameState, "artifacts">,
  turn: TurnPlanItem,
): GameArtifact | undefined {
  const artifacts = state.artifacts;
  if (turn.sourceRule === "previous_artifact") return artifacts.at(-1);
  if (turn.sourceRule === "latest_drawing" || turn.sourceRule === "memory_flash") {
    return [...artifacts].reverse().find((artifact) => artifact.kind === "drawing");
  }
  if (turn.sourceRule === "latest_text") {
    return [...artifacts]
      .reverse()
      .find((artifact) => artifact.kind !== "drawing");
  }
  // Blind-prompt source artifacts are deliberately not returned here.
  return undefined;
}

/** Resolves an authored manual Blind Prompt ladder without exposing its target text. */
export function getManualBlindClues(
  state: Pick<GameState, "artifacts">,
  turn: TurnPlanItem,
): readonly ClueBeat[] {
  if (turn.action !== "blind_draw" || turn.clueSchedule) return turn.clueSchedule ?? [];
  const prompt = [...state.artifacts]
    .reverse()
    .find((artifact): artifact is PromptArtifact => artifact.kind === "prompt");
  return buildManualClueSchedule(prompt?.clues ?? [], turn.timerSeconds);
}

/**
 * Produces a client-safe view. Secret prompt text is revealed only for the
 * gallery, and clue visibility is based on elapsed turn time.
 */
export function redactTurnForPlayer(
  turn: TurnPlanItem,
  _viewerIndex: PlayerSlot,
  elapsedSeconds = 0,
  revealSecrets = false,
  resolvedManualClues?: readonly ClueBeat[],
): TurnView {
  const { secretPrompt, clueSchedule, ...safeTurn } = turn;
  const clues = resolvedManualClues ?? clueSchedule;
  return {
    ...safeTurn,
    visiblePrompt: revealSecrets
      ? secretPrompt ?? turn.promptCard?.text
      : turn.action === "blind_draw"
        ? undefined
        : turn.promptCard?.text,
    availableClues: revealSecrets
      ? clues ?? []
      : getAvailableClues(clues, elapsedSeconds),
  };
}

export function getTurnInstruction(
  turn: TurnPlanItem,
  players?: PlayerPair,
) {
  const actorName = players?.[turn.actorIndex]?.name ?? `Player ${turn.actorIndex + 1}`;
  return {
    eyebrow: `Round ${turn.roundNumber} of ${turn.totalRounds} · ${turn.phaseLabel}`,
    title: `${actorName}, ${turn.headline.charAt(0).toLowerCase()}${turn.headline.slice(1)}`,
    body: turn.instruction,
    timerLabel: `${turn.timerSeconds} seconds`,
    sourceLabel:
      turn.sourceRule === "memory_flash"
        ? `Reference flashes for ${turn.previewSeconds ?? 0} seconds`
        : turn.sourceRule === "clues_only"
          ? "The target stays hidden"
          : undefined,
  };
}

export function createInitialGameState(
  settingsInput: GameSettingsInput,
  players: PlayerPair,
  options: CreateGameOptions = {},
): GameState {
  if (players.length !== 2) {
    throw new Error("Ink & Echo games require exactly two players.");
  }
  const settings = normalizeGameSettings(settingsInput);
  const seed = options.seed ?? `${players[0].id}:${players[1].id}:${settings.mode}`;
  return {
    id: options.gameId ?? `game-${hashGameSeed(seed).toString(36)}`,
    seed,
    status: "playing",
    settings,
    players,
    turns: createTurnPlan(settings, { seed, starterIndex: options.starterIndex }),
    currentTurnIndex: 0,
    artifacts: [],
    startedAt: options.startedAt,
  };
}

function isBlankText(artifact: TurnArtifactInput): boolean {
  return artifact.kind !== "drawing" && artifact.text.trim().length === 0;
}

function materializeArtifact(
  turn: TurnPlanItem,
  submission: TurnSubmission,
): GameArtifact {
  const base = {
    id: `${turn.id}-artifact`,
    turnId: turn.id,
    roundNumber: turn.roundNumber,
    authorId: submission.actorId,
    createdAt: submission.createdAt,
  };
  const input = submission.artifact;
  if (input.kind === "drawing") return { ...base, kind: "drawing", snapshot: input.snapshot };
  if (input.kind === "caption") return { ...base, kind: "caption", text: input.text.trim() };
  if (input.kind === "guess") return { ...base, kind: "guess", text: input.text.trim() };
  return {
    ...base,
    kind: "prompt",
    text: input.text.trim(),
    clues: input.clues?.map((clue) => clue.trim()).filter(Boolean).slice(0, 4),
  };
}

/** Pure validated state transition for one submitted turn. */
export function submitTurn(state: GameState, submission: TurnSubmission): GameTransition {
  const turn = getActiveTurn(state);
  if (!turn) return { ok: false, state, error: "This game is already in the gallery." };
  const actor = state.players[turn.actorIndex];
  if (submission.actorId !== actor.id) {
    return { ok: false, state, error: `It is ${actor.name}'s turn.` };
  }
  if (submission.artifact.kind !== turn.artifactKind) {
    return {
      ok: false,
      state,
      error: `This turn expects a ${turn.artifactKind}, not a ${submission.artifact.kind}.`,
    };
  }
  if (isBlankText(submission.artifact)) {
    return { ok: false, state, error: "Add a little something before passing the turn." };
  }
  if (
    turn.action === "write_prompt" &&
    state.settings.mode === "blind-prompt" &&
    !state.settings.randomPrompts &&
    submission.artifact.kind === "prompt" &&
    (submission.artifact.clues?.filter((clue) => clue.trim()).length ?? 0) < 2
  ) {
    return { ok: false, state, error: "Add at least two clues for the blind drawing round." };
  }

  const artifact = materializeArtifact(turn, submission);
  const nextIndex = state.currentTurnIndex + 1;
  const completed = nextIndex >= state.turns.length;
  const nextState: GameState = {
    ...state,
    status: completed ? "gallery" : "playing",
    currentTurnIndex: nextIndex,
    artifacts: [...state.artifacts, artifact],
    completedAt: completed ? submission.createdAt : state.completedAt,
  };
  return { ok: true, state: nextState, completedTurn: turn };
}

/** Alias with a UI-friendly name. */
export function advanceGame(state: GameState, submission: TurnSubmission): GameTransition {
  return submitTurn(state, submission);
}

export function getGalleryEntries(state: GameState): readonly GalleryEntry[] {
  return state.turns.map((turn) => ({
    turn,
    artifact: state.artifacts.find((artifact) => artifact.turnId === turn.id),
    author: state.players[turn.actorIndex],
  }));
}
