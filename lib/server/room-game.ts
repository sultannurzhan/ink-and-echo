export const GAME_MODES = [
  "classic-chain",
  "memory-drift",
  "blind-prompt",
  "remix-mode",
  "speed-chaos",
  "story-canvas",
  "guess-evolution",
] as const;

export type GameMode = (typeof GAME_MODES)[number];
export type CanvasSize = "classic" | "wide" | "square";
export type RoomStatus = "waiting" | "playing" | "finished";
export type TurnKind =
  | "prompt"
  | "drawing"
  | "guess"
  | "seed-drawing"
  | "memory-drawing"
  | "blind-drawing"
  | "remix"
  | "caption";

export interface RoomSettings {
  mode: GameMode;
  rounds: number;
  timerSeconds: number;
  randomPrompts: boolean;
  canvasSize: CanvasSize;
}

export interface RoomPlayer {
  id: string;
  name: string;
  seat: 0 | 1;
}

export interface TurnState {
  kind: TurnKind;
  actorPlayerId: string;
  instruction: string;
  sourceEntryId?: string;
  suggestedPrompt?: string;
  rule?: string;
  clues?: string[];
  automaticClues?: string[];
  promptAuthorId?: string;
  revealUntil?: number;
  deadlineAt: number;
}

export interface StoredGameState {
  round: number;
  turnNumber: number;
  currentTurn: TurnState | null;
}

export interface EntryDraft {
  id: string;
  round: number;
  authorPlayerId: string;
  kind: string;
  textContent: string | null;
  imageData: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

const DEFAULT_SETTINGS: RoomSettings = {
  mode: "classic-chain",
  rounds: 6,
  timerSeconds: 90,
  randomPrompts: true,
  canvasSize: "classic",
};

const MODE_ALIASES: Record<string, GameMode> = {
  classic: "classic-chain",
  "classic-chain": "classic-chain",
  memory: "memory-drift",
  "memory-drift": "memory-drift",
  blind: "blind-prompt",
  "blind-prompt": "blind-prompt",
  remix: "remix-mode",
  "remix-mode": "remix-mode",
  speed: "speed-chaos",
  "speed-chaos": "speed-chaos",
  story: "story-canvas",
  "story-canvas": "story-canvas",
  evolution: "guess-evolution",
  "guess-evolution": "guess-evolution",
};

const PROMPTS = [
  "A ghost trying to return a library book",
  "Two frogs opening a tiny bakery",
  "A detective who is secretly three ducks",
  "The moon taking a very awkward selfie",
  "A dragon nervous about its first day of school",
  "A suspicious sandwich at a fancy party",
  "A robot learning how to give a hug",
  "A cat running a midnight radio station",
  "An octopus assembling flat-pack furniture",
  "A wizard whose only spell makes soup",
  "A cloud keeping a tiny secret",
  "A penguin winning an underground dance battle",
] as const;

const REMIX_RULES = [
  "Make it wildly dramatic",
  "Turn one part into a friendly monster",
  "Add something deeply suspicious",
  "Move the scene to outer space",
  "Make everything look unexpectedly fancy",
  "Add a tiny character with a huge problem",
  "Change the mood to a cozy rainy day",
  "Give the main subject a secret identity",
  "Make gravity stop working",
  "Add the worst possible sidekick",
] as const;

function integerInRange(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.round(parsed)))
    : fallback;
}

export function normalizeSettings(
  input: unknown,
  base: RoomSettings = DEFAULT_SETTINGS,
): RoomSettings {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const requestedMode = typeof value.mode === "string" ? value.mode.toLowerCase() : "";
  const mode = MODE_ALIASES[requestedMode] ?? base.mode;
  const rawCanvas = value.canvasSize ?? value.canvasPreset;
  const requestedCanvas =
    typeof rawCanvas === "string" ? rawCanvas.toLowerCase() : "";

  return {
    mode,
    rounds: integerInRange(value.rounds ?? value.roundCount, base.rounds, 1, 20),
    timerSeconds: integerInRange(
      value.timerSeconds ?? value.timer,
      Math.min(base.timerSeconds, mode === "speed-chaos" ? 25 : 180),
      10,
      mode === "speed-chaos" ? 25 : 180,
    ),
    randomPrompts:
      typeof value.randomPrompts === "boolean"
        ? value.randomPrompts
        : base.randomPrompts,
    canvasSize:
      requestedCanvas === "classic" || requestedCanvas === "wide" || requestedCanvas === "square"
        ? requestedCanvas
        : requestedCanvas === "landscape"
          ? "wide"
          : requestedCanvas === "portrait"
            ? "classic"
            : base.canvasSize,
  };
}

export function waitingState(): StoredGameState {
  return { round: 0, turnNumber: 0, currentTurn: null };
}

function pick<T>(items: readonly T[]): T {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return items[random[0] % items.length];
}

function turnDuration(settings: RoomSettings, kind: TurnKind): number {
  if (settings.mode !== "speed-chaos") return settings.timerSeconds;
  return kind === "guess"
    ? Math.min(settings.timerSeconds, 15)
    : Math.min(settings.timerSeconds, 25);
}

function makeTurn(
  settings: RoomSettings,
  now: number,
  turn: Omit<TurnState, "deadlineAt">,
): TurnState {
  return {
    ...turn,
    deadlineAt: now + turnDuration(settings, turn.kind) * 1_000,
  };
}

function promptSuggestion(settings: RoomSettings): string | undefined {
  return settings.randomPrompts ? pick(PROMPTS) : undefined;
}

export function initialGameState(
  settings: RoomSettings,
  hostPlayerId: string,
  now: number,
): StoredGameState {
  let turn: TurnState;

  switch (settings.mode) {
    case "memory-drift":
      turn = makeTurn(settings, now, {
        kind: "seed-drawing",
        actorPlayerId: hostPlayerId,
        instruction: "Draw a memorable seed image. Your partner will only glimpse it.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 0, turnNumber: 1, currentTurn: turn };
    case "remix-mode":
      turn = makeTurn(settings, now, {
        kind: "seed-drawing",
        actorPlayerId: hostPlayerId,
        instruction: "Draw the seed image that every remix will build on.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 0, turnNumber: 1, currentTurn: turn };
    case "story-canvas":
      turn = makeTurn(settings, now, {
        kind: "drawing",
        actorPlayerId: hostPlayerId,
        instruction: "Draw the opening panel of your shared story.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
    case "blind-prompt":
      turn = makeTurn(settings, now, {
        kind: "prompt",
        actorPlayerId: hostPlayerId,
        instruction: "Write the secret prompt. Your partner will receive clues, not the answer.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
    case "speed-chaos": {
      const seed = promptSuggestion(settings);
      turn = makeTurn(settings, now, {
        kind: "drawing",
        actorPlayerId: hostPlayerId,
        instruction: seed
          ? `Quick draw: ${seed}`
          : "Quick draw: invent a ridiculous idea—now!",
        suggestedPrompt: seed,
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
    }
    case "guess-evolution":
      turn = makeTurn(settings, now, {
        kind: "prompt",
        actorPlayerId: hostPlayerId,
        instruction: "Plant one opening idea. After this, the chain will never reset.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
    case "classic-chain":
      turn = makeTurn(settings, now, {
        kind: "prompt",
        actorPlayerId: hostPlayerId,
        instruction: "Write a prompt to begin this three-beat mini-chain.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
    default:
      turn = makeTurn(settings, now, {
        kind: "prompt",
        actorPlayerId: hostPlayerId,
        instruction: "Write the opening prompt for your two-person chain.",
        suggestedPrompt: promptSuggestion(settings),
      });
      return { round: 1, turnNumber: 1, currentTurn: turn };
  }
}

function otherPlayer(players: RoomPlayer[], playerId: string): RoomPlayer {
  const other = players.find((player) => player.id !== playerId);
  if (!other) throw new Error("This turn needs both players in the room.");
  return other;
}

function automaticClues(prompt: string): string[] {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0]?.toUpperCase() ?? "?";
  const last = words.at(-1)?.[0]?.toUpperCase() ?? "?";
  return [
    `The prompt has ${words.length} word${words.length === 1 ? "" : "s"}.`,
    `Its first word begins with “${first}”.`,
    `Its last word begins with “${last}”.`,
  ];
}

function finishedState(state: StoredGameState): StoredGameState {
  return {
    ...state,
    currentTurn: null,
  };
}

export function advanceAfterText(args: {
  settings: RoomSettings;
  state: StoredGameState;
  players: RoomPlayer[];
  actorPlayerId: string;
  entryId: string;
  text: string;
  now: number;
}): { state: StoredGameState; finished: boolean } {
  const { settings, state, players, actorPlayerId, entryId, text, now } = args;
  const turn = state.currentTurn;
  if (!turn) throw new Error("The game does not have an active turn.");

  if (turn.kind === "prompt") {
    const countsEveryHandoff =
      settings.mode === "classic-chain" || settings.mode === "guess-evolution";
    if (countsEveryHandoff && state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    const drawer = otherPlayer(players, actorPlayerId);
    const next = settings.mode === "blind-prompt"
      ? makeTurn(settings, now, {
          kind: "blind-drawing",
          actorPlayerId: drawer.id,
          instruction: "Draw from the clues without peeking at the secret prompt.",
          sourceEntryId: entryId,
          promptAuthorId: actorPlayerId,
          automaticClues: automaticClues(text),
          clues: automaticClues(text).slice(0, 1),
        })
      : makeTurn(settings, now, {
          kind: "drawing",
          actorPlayerId: drawer.id,
          instruction: "Draw what the previous text makes you imagine.",
          sourceEntryId: entryId,
        });

    return {
      state: {
        ...state,
        round: countsEveryHandoff ? state.round + 1 : state.round,
        turnNumber: state.turnNumber + 1,
        currentTurn: next,
      },
      finished: false,
    };
  }

  if (turn.kind === "guess") {
    if (state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    if (settings.mode === "classic-chain") {
      const nextPromptWriter = otherPlayer(players, actorPlayerId);
      return {
        state: {
          round: state.round + 1,
          turnNumber: state.turnNumber + 1,
          currentTurn: makeTurn(settings, now, {
            kind: "prompt",
            actorPlayerId: nextPromptWriter.id,
            instruction: "Fresh mini-chain: write a completely new prompt.",
            suggestedPrompt: promptSuggestion(settings),
          }),
        },
        finished: false,
      };
    }

    const nextDrawer = otherPlayer(players, actorPlayerId);
    return {
      state: {
        round: state.round + 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "drawing",
          actorPlayerId: nextDrawer.id,
          instruction: settings.mode === "speed-chaos"
            ? "No polishing—turn that snap guess into a quick drawing."
            : "Turn your guess into the next drawing; the idea keeps evolving.",
          sourceEntryId: entryId,
        }),
      },
      finished: false,
    };
  }

  if (turn.kind === "caption" && settings.mode === "story-canvas") {
    if (state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    return {
      state: {
        round: state.round + 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "drawing",
          actorPlayerId,
          instruction: "Draw the next panel using the last caption as your launch point.",
          sourceEntryId: entryId,
        }),
      },
      finished: false,
    };
  }

  throw new Error(`A text submission is not valid during a ${turn.kind} turn.`);
}

export function advanceAfterDrawing(args: {
  settings: RoomSettings;
  state: StoredGameState;
  players: RoomPlayer[];
  actorPlayerId: string;
  entryId: string;
  now: number;
}): { state: StoredGameState; finished: boolean } {
  const { settings, state, players, actorPlayerId, entryId, now } = args;
  const turn = state.currentTurn;
  if (!turn) throw new Error("The game does not have an active turn.");
  const partner = otherPlayer(players, actorPlayerId);

  if (turn.kind === "drawing" && settings.mode === "story-canvas") {
    return {
      state: {
        ...state,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "caption",
          actorPlayerId: partner.id,
          instruction: "Caption this panel and steer the story somewhere surprising.",
          sourceEntryId: entryId,
        }),
      },
      finished: false,
    };
  }

  if (turn.kind === "drawing") {
    const countsEveryHandoff =
      settings.mode === "classic-chain" ||
      settings.mode === "guess-evolution" ||
      settings.mode === "speed-chaos";
    if (countsEveryHandoff && state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    return {
      state: {
        ...state,
        round: countsEveryHandoff ? state.round + 1 : state.round,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "guess",
          actorPlayerId: partner.id,
          instruction: settings.mode === "speed-chaos"
            ? "Snap guess—name it before second thoughts arrive."
            : settings.mode === "guess-evolution"
              ? "Name only what you see; this guess becomes the next drawing seed."
              : "Guess the idea using only the drawing you received.",
          sourceEntryId: entryId,
        }),
      },
      finished: false,
    };
  }

  if (turn.kind === "seed-drawing" && settings.mode === "memory-drift") {
    return {
      state: {
        round: 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: {
          ...makeTurn(settings, now, {
            kind: "memory-drawing",
            actorPlayerId: partner.id,
            instruction: "Study the image briefly, then recreate it from memory.",
            sourceEntryId: entryId,
          }),
          revealUntil: now + 6_000,
        },
      },
      finished: false,
    };
  }

  if (turn.kind === "memory-drawing") {
    if (state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    return {
      state: {
        round: state.round + 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: {
          ...makeTurn(settings, now, {
            kind: "memory-drawing",
            actorPlayerId: partner.id,
            instruction: "Catch the quick glimpse, then redraw what your memory kept.",
            sourceEntryId: entryId,
          }),
          revealUntil: now + Math.max(2_500, 6_000 - state.round * 500),
        },
      },
      finished: false,
    };
  }

  if (turn.kind === "seed-drawing" && settings.mode === "remix-mode") {
    return {
      state: {
        round: 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "remix",
          actorPlayerId: partner.id,
          instruction: "Keep the recognizable core, then obey the remix rule.",
          sourceEntryId: entryId,
          rule: pick(REMIX_RULES),
        }),
      },
      finished: false,
    };
  }

  if (turn.kind === "remix") {
    if (state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    return {
      state: {
        round: state.round + 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "remix",
          actorPlayerId: partner.id,
          instruction: "Remix the latest version without losing its family resemblance.",
          sourceEntryId: entryId,
          rule: pick(REMIX_RULES),
        }),
      },
      finished: false,
    };
  }

  if (turn.kind === "blind-drawing" && settings.mode === "blind-prompt") {
    if (state.round >= settings.rounds) {
      return { state: finishedState(state), finished: true };
    }

    return {
      state: {
        round: state.round + 1,
        turnNumber: state.turnNumber + 1,
        currentTurn: makeTurn(settings, now, {
          kind: "prompt",
          actorPlayerId,
          instruction: "Write the next secret prompt for your partner.",
          sourceEntryId: entryId,
          suggestedPrompt: promptSuggestion(settings),
        }),
      },
      finished: false,
    };
  }

  throw new Error(`A drawing submission is not valid during a ${turn.kind} turn.`);
}

export function addBlindClue(args: {
  settings: RoomSettings;
  state: StoredGameState;
  actorPlayerId: string;
  text: string;
  now: number;
}): StoredGameState {
  const { settings, state, actorPlayerId, text, now } = args;
  const turn = state.currentTurn;

  if (!turn || turn.kind !== "blind-drawing") {
    throw new Error("Clues can only be added during a Blind Prompt drawing turn.");
  }
  const isPromptAuthor = turn.promptAuthorId === actorPlayerId;
  const isDrawerRequestingHint = turn.actorPlayerId === actorPlayerId && !text.trim();
  if (!isPromptAuthor && !isDrawerRequestingHint) {
    throw new Error("Only the prompt writer can add a custom clue; the drawer can request the next hint.");
  }

  const existing = turn.clues ?? [];
  const automatic = turn.automaticClues ?? [];
  const nextAutomatic = automatic.find((clue) => !existing.includes(clue));
  const nextClue = text.trim() || nextAutomatic;
  if (!nextClue) throw new Error("There are no more automatic clues; write a custom clue.");

  return {
    ...state,
    turnNumber: state.turnNumber + 1,
    currentTurn: {
      ...turn,
      clues: [...existing, nextClue],
      deadlineAt: Math.max(turn.deadlineAt, now + Math.min(20, settings.timerSeconds) * 1_000),
    },
  };
}

export function expectedTextKind(kind: TurnKind): "prompt" | "guess" | "caption" | null {
  return kind === "prompt" || kind === "guess" || kind === "caption" ? kind : null;
}

export function isDrawingTurn(kind: TurnKind): boolean {
  return kind === "drawing" || kind === "seed-drawing" || kind === "memory-drawing" || kind === "blind-drawing" || kind === "remix";
}
