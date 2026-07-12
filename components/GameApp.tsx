"use client";
/* eslint-disable @next/next/no-img-element -- Player-created data URLs cannot use Next image optimization. */

import { useCallback, useEffect, useRef, useState } from "react";
import { DrawingCanvas, type DrawingCanvasHandle } from "@/components/DrawingCanvas";
import {
  isConfirmedInvalidAuth,
  pollingDelay,
  readRoomJson,
  roomAuthHeaders,
  RoomApiError,
  shouldApplyRoomVersion,
} from "@/lib/client/room-transport";
import {
  listRecoverySessions,
  makeResumeUrl,
  pruneRecoverySessions,
  readActiveCredentials,
  readLegacyCredentials,
  readRecoverySession,
  removeActiveCredentials,
  removeLegacyCredentials,
  removeRoomSession,
  saveActiveCredentials,
  saveRecoverySession,
  type StoredRoomSession,
} from "@/lib/client/room-session";
import {
  deleteTurnDraft,
  readTurnDraft,
  saveTurnDraft,
  turnDraftKey,
} from "@/lib/client/draft-store";

type View = "landing" | "create" | "join" | "lobby" | "game" | "gallery";
type ModeId =
  | "classic-chain"
  | "memory-drift"
  | "blind-prompt"
  | "remix-mode"
  | "speed-chaos"
  | "story-canvas"
  | "guess-evolution";

type Settings = {
  mode: ModeId;
  rounds: number;
  timerSeconds: number;
  randomPrompts: boolean;
  canvasSize: "square" | "classic" | "wide";
};

type Player = {
  id: string;
  name: string;
  isHost?: boolean;
  isOnline?: boolean;
  lastSeenAt?: number;
};
type GalleryEntry = {
  id?: string;
  round: number;
  kind: string;
  playerId?: string;
  playerName?: string;
  text?: string;
  imageData?: string;
  rule?: string;
};
type CurrentTurn = {
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
  canAddClue?: boolean;
};
type Room = {
  code: string;
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
type Session = {
  room: Room;
  playerId: string;
  playerToken: string;
  recoveryToken?: string;
  playerName?: string;
};

const MODES: Array<{
  id: ModeId;
  icon: string;
  name: string;
  kicker: string;
  description: string;
  accent: string;
}> = [
  {
    id: "classic-chain",
    icon: "↝",
    name: "Classic Chain",
    kicker: "The dependable giggle",
    description: "Prompt, doodle, guess, repeat — long enough for the idea to become delightfully wrong.",
    accent: "coral",
  },
  {
    id: "memory-drift",
    icon: "◒",
    name: "Memory Drift",
    kicker: "Look. Hide. Recreate.",
    description: "Study a drawing for a few seconds, then rebuild it from the fuzzy leftovers in your brain.",
    accent: "violet",
  },
  {
    id: "blind-prompt",
    icon: "◌",
    name: "Blind Prompt",
    kicker: "Clues, not answers",
    description: "Draw from vague clues that arrive one at a time. Commitment is part of the comedy.",
    accent: "blue",
  },
  {
    id: "remix-mode",
    icon: "✦",
    name: "Remix Mode",
    kicker: "Yes, and… with crayons",
    description: "Keep the old drawing, then make it dramatic, suspicious, tiny, haunted, or unexpectedly fancy.",
    accent: "yellow",
  },
  {
    id: "speed-chaos",
    icon: "⚡",
    name: "Speed Chaos",
    kicker: "No time for perfection",
    description: "Tiny timers, ridiculous prompts, instinctive guesses. Your first idea wins by default.",
    accent: "coral",
  },
  {
    id: "story-canvas",
    icon: "▦",
    name: "Story Canvas",
    kicker: "A comic for two",
    description: "Alternate panels and captions until your tiny visual story has a beginning, middle, and weird end.",
    accent: "green",
  },
  {
    id: "guess-evolution",
    icon: "≈",
    name: "Guess Evolution",
    kicker: "Meaning mutates",
    description: "Each new drawing only sees the last guess, creating a slow-motion game of visual telephone.",
    accent: "violet",
  },
];

const DEFAULT_SETTINGS: Settings = {
  mode: "classic-chain",
  rounds: 6,
  timerSeconds: 90,
  randomPrompts: true,
  canvasSize: "classic",
};

const MODE_RECIPES: Record<ModeId, Pick<Settings, "rounds" | "timerSeconds" | "canvasSize">> = {
  "classic-chain": { rounds: 9, timerSeconds: 60, canvasSize: "classic" },
  "memory-drift": { rounds: 7, timerSeconds: 60, canvasSize: "square" },
  "blind-prompt": { rounds: 6, timerSeconds: 60, canvasSize: "classic" },
  "remix-mode": { rounds: 8, timerSeconds: 60, canvasSize: "classic" },
  "speed-chaos": { rounds: 10, timerSeconds: 20, canvasSize: "square" },
  "story-canvas": { rounds: 8, timerSeconds: 90, canvasSize: "classic" },
  "guess-evolution": { rounds: 9, timerSeconds: 60, canvasSize: "square" },
};

const DEMO_PROMPTS = [
  "A moon taking its pet cloud for a walk",
  "Two frogs opening a tiny bakery",
  "A detective sandwich following crumbs",
  "A very formal dragon at karaoke",
  "A ghost trying to take a group photo",
];

const DEMO_REMIX_RULES = [
  "Make it dramatic",
  "Turn one detail into a monster",
  "Add something suspicious",
  "Make it unexpectedly fancy",
];

const DEMO_EMPTY_DRAWING = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Avz6WQAAAABJRU5ErkJggg==";

function normalizeRoom(value: unknown): Room {
  const body = value as { room?: Room } & Room;
  return body.room ?? body;
}

function modeById(id: ModeId) {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}

function withModeRecipe(current: Settings, mode: ModeId): Settings {
  return { ...current, mode, ...MODE_RECIPES[mode] };
}

function makeInviteUrl(code: string) {
  if (typeof window === "undefined") return code;
  return `${window.location.origin}${window.location.pathname}?room=${code}`;
}

function viewForRoom(room: Room): View {
  if (room.phase === "playing") return "game";
  if (room.phase === "gallery" || room.phase === "finished") return "gallery";
  return "lobby";
}

function persistRoomSession(session: Session) {
  if (typeof window === "undefined" || session.room.code === "DEMO") return true;
  const activeSaved = saveActiveCredentials(window.sessionStorage, session.room.code, {
    playerId: session.playerId,
    playerToken: session.playerToken,
  });
  const recoverySaved = session.recoveryToken
    ? saveRecoverySession(window.localStorage, {
        code: session.room.code,
        playerId: session.playerId,
        recoveryToken: session.recoveryToken,
        playerName: session.playerName,
        phase: session.room.phase,
        updatedAt: Date.now(),
      })
    : true;
  return activeSaved && recoverySaved;
}

function roomTurnSignature(room: Room) {
  const turn = room.currentTurn;
  return [
    room.turnNumber ?? room.turnIndex ?? 0,
    turn?.round ?? 0,
    turn?.kind ?? "waiting",
    turn?.playerId ?? room.activePlayerId ?? "none",
    turn?.sourceEntryId ?? "seed",
  ].join(":");
}

export function GameApp() {
  const [view, setView] = useState<View>("landing");
  const [playerName, setPlayerName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [recentRooms, setRecentRooms] = useState<StoredRoomSession[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const pollFailureCount = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const wakePollRef = useRef<(() => void) | null>(null);
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef("");

  const room = session?.room;
  const roomCode = room?.code;
  const roomPhase = room?.phase;
  const selectedMode = modeById(settings.mode);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const acceptSession = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
    setView(viewForRoom(next.room));
    setReconnecting(false);
    setError("");
    const saved = persistRoomSession(next);
    setStorageWarning(!saved);
    if (typeof window !== "undefined") {
      if (next.recoveryToken) removeLegacyCredentials(window.localStorage, next.room.code);
      setRecentRooms(listRecoverySessions(window.localStorage));
      window.history.replaceState({}, "", `?room=${next.room.code}`);
    }
  }, []);

  const resumeRoom = useCallback(async (
    code: string,
    override?: { playerId: string; recoveryToken: string },
  ) => {
    const normalizedCode = code.toUpperCase();
    setLoading(true);
    setError("");
    const savedRecovery = readRecoverySession(window.localStorage, normalizedCode);
    const recovery = override ?? (savedRecovery?.recoveryToken
      ? { playerId: savedRecovery.playerId, recoveryToken: savedRecovery.recoveryToken }
      : undefined);
    const active = override
      ? undefined
      : readActiveCredentials(window.sessionStorage, normalizedCode)
        ?? readLegacyCredentials(window.localStorage, normalizedCode);

    if (active) {
      try {
        const response = await fetch(`/api/rooms/${normalizedCode}`, {
          cache: "no-store",
          headers: roomAuthHeaders(active),
        });
        const body = await readRoomJson(response);
        acceptSession({
          room: normalizeRoom(body),
          playerId: active.playerId,
          playerToken: active.playerToken,
          recoveryToken: typeof body.recoveryToken === "string"
            ? body.recoveryToken
            : recovery?.recoveryToken,
          playerName: savedRecovery?.playerName,
        });
        setLoading(false);
        return true;
      } catch (cause) {
        if (!isConfirmedInvalidAuth(cause)) {
          setLoading(false);
          setReconnecting(true);
          setError("We could not reconnect yet. Your saved seat is safe — try again when the connection settles.");
          return false;
        }
        removeActiveCredentials(window.sessionStorage, normalizedCode);
      }
    }

    if (recovery) {
      try {
        const response = await fetch(`/api/rooms/${normalizedCode}/recover`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recovery),
        });
        const body = await readRoomJson(response);
        const next: Session = {
          room: normalizeRoom(body),
          playerId: String(body.playerId ?? recovery.playerId),
          playerToken: String(body.playerToken),
          recoveryToken: String(body.recoveryToken ?? recovery.recoveryToken),
          playerName: typeof body.player === "object" && body.player
            ? String((body.player as { name?: string }).name ?? savedRecovery?.playerName ?? "")
            : savedRecovery?.playerName,
        };
        acceptSession(next);
        setLoading(false);
        return true;
      } catch (cause) {
        if (isConfirmedInvalidAuth(cause)) {
          const latestRecovery = readRecoverySession(window.localStorage, normalizedCode);
          const recoveryWasRotatedElsewhere = Boolean(
            latestRecovery &&
            (latestRecovery.playerId !== recovery.playerId ||
              latestRecovery.recoveryToken !== recovery.recoveryToken),
          );
          if (override || recoveryWasRotatedElsewhere) {
            setRecentRooms(listRecoverySessions(window.localStorage));
            setError(
              recoveryWasRotatedElsewhere
                ? "Another tab refreshed this seat first. Its newer recovery key was kept safe — press Resume once more."
                : "That private recovery link has expired. Any newer seat saved on this device was kept safe.",
            );
          } else {
            removeRoomSession(window.localStorage, window.sessionStorage, normalizedCode);
            setRecentRooms(listRecoverySessions(window.localStorage));
            setError("That saved seat is no longer valid. You can still join an open seat with the room code.");
          }
        } else {
          setReconnecting(true);
          setError("The room is temporarily unreachable. Your recovery key was kept safely on this device.");
        }
        setLoading(false);
        return false;
      }
    }

    setLoading(false);
    return false;
  }, [acceptSession]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room")?.toUpperCase();
    pruneRecoverySessions(window.localStorage, 45 * 24 * 60 * 60 * 1000);
    const refreshRecentRooms = window.setTimeout(() => {
      setRecentRooms(listRecoverySessions(window.localStorage));
    }, 0);
    if (!code) return () => window.clearTimeout(refreshRecentRooms);
    let cancelled = false;
    const revealInvite = window.setTimeout(() => {
      void (async () => {
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const resumeValue = hash.get("resume");
        const separator = resumeValue?.indexOf(".") ?? -1;
        const override = resumeValue && separator > 0
          ? {
              playerId: resumeValue.slice(0, separator),
              recoveryToken: resumeValue.slice(separator + 1),
            }
          : undefined;
        const resumed = await resumeRoom(code, override);
        if (cancelled || resumed) return;
        const hasSavedRecovery = Boolean(readRecoverySession(window.localStorage, code));
        if (!hasSavedRecovery) {
          setJoinCode(code);
          setView("join");
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshRecentRooms);
      window.clearTimeout(revealInvite);
    };
  }, [resumeRoom]);

  useEffect(() => {
    if (!roomCode || roomCode === "DEMO") return;
    const code = roomCode;
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(`ink-and-echo:${code}`);
    broadcastRef.current = channel;
    channel?.addEventListener("message", () => wakePollRef.current?.());
    return () => {
      channel?.close();
      if (broadcastRef.current === channel) broadcastRef.current = null;
    };
  }, [roomCode]);

  const applyRoomSnapshot = useCallback((nextRoom: Room) => {
    const current = sessionRef.current;
    if (!current || current.room.code !== nextRoom.code) return false;
    const newerGameState = shouldApplyRoomVersion(current.room.version, nextRoom.version);
    const newerPresence =
      nextRoom.version === current.room.version &&
      Number.isFinite(nextRoom.presenceVersion) &&
      nextRoom.presenceVersion !== current.room.presenceVersion;
    if (!newerGameState && !newerPresence) return false;
    const next = { ...current, room: nextRoom };
    sessionRef.current = next;
    setSession(next);
    persistRoomSession(next);
    setReconnecting(false);
    pollFailureCount.current = 0;
    if (nextRoom.phase === "playing") setView("game");
    if (nextRoom.phase === "gallery" || nextRoom.phase === "finished") setView("gallery");
    return true;
  }, []);

  useEffect(() => {
    if (
      !roomCode ||
      roomCode === "DEMO" ||
      roomPhase === "gallery" ||
      roomPhase === "finished"
    ) return;
    const code = roomCode;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const schedule = (delay: number) => {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        schedule(4_000);
        return;
      }
      const current = sessionRef.current;
      if (!current || current.room.code !== code) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const query = new URLSearchParams({
          sinceVersion: String(current.room.version),
          sincePresenceVersion: String(current.room.presenceVersion ?? 0),
        });
        const response = await fetch(`/api/rooms/${code}?${query}`, {
          cache: "no-store",
          headers: roomAuthHeaders(current),
          signal: requestController.signal,
        });
        if (response.status !== 304) {
          const body = await readRoomJson(response);
          applyRoomSnapshot(normalizeRoom(body));
        }
        pollFailureCount.current = 0;
        setReconnecting(false);
        schedule(900);
      } catch (cause) {
        if (requestController.signal.aborted || stopped) return;
        if (isConfirmedInvalidAuth(cause)) {
          const recovered = await resumeRoom(code);
          if (!recovered) setReconnecting(true);
          return;
        }
        pollFailureCount.current += 1;
        setReconnecting(true);
        schedule(pollingDelay(pollFailureCount.current));
      } finally {
        if (controller === requestController) controller = null;
      }
    };

    wakePollRef.current = () => {
      controller?.abort();
      window.clearTimeout(timer);
      void poll();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") wakePollRef.current?.();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      wakePollRef.current = null;
    };
  }, [applyRoomSnapshot, resumeRoom, roomCode, roomPhase]);

  async function createRoom() {
    if (!playerName.trim()) {
      setError("Give yourself a doodling name first.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerName: playerName.trim(), settings }),
      });
      const body = await readRoomJson(response);
      const next: Session = {
        room: normalizeRoom(body),
        playerId: String(body.playerId),
        playerToken: String(body.playerToken),
        recoveryToken: String(body.recoveryToken ?? "") || undefined,
        playerName: playerName.trim(),
      };
      acceptSession(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not make the room.");
    } finally {
      setLoading(false);
    }
  }

  async function joinRoom() {
    if (!playerName.trim()) {
      setError("What should your drawing partner call you?");
      return;
    }
    const code = joinCode.trim().toUpperCase();
    if (code.length < 6) {
      setError("That room code looks a little short.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerName: playerName.trim() }),
      });
      const body = await readRoomJson(response);
      const next: Session = {
        room: normalizeRoom(body),
        playerId: String(body.playerId),
        playerToken: String(body.playerToken),
        recoveryToken: String(body.recoveryToken ?? "") || undefined,
        playerName: playerName.trim(),
      };
      acceptSession(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join that room.");
    } finally {
      setLoading(false);
    }
  }

  function startPassAndPlay() {
    const hostName = playerName.trim() || "Doodler One";
    const demoRoom: Room = {
      code: "DEMO",
      phase: "playing",
      version: 1,
      hostPlayerId: "demo-a",
      activePlayerId: "demo-a",
      turnIndex: 0,
      totalTurns: settings.rounds,
      settings,
      players: [
        { id: "demo-a", name: hostName, isHost: true },
        { id: "demo-b", name: "Doodler Two" },
      ],
      currentTurn: {
        kind: "prompt",
        round: 1,
        playerId: "demo-a",
        instruction: "Plant the first strange little idea.",
        prompt: settings.randomPrompts ? DEMO_PROMPTS[0] : undefined,
      },
      gallery: [],
    };
    setSession({ room: demoRoom, playerId: "demo-a", playerToken: "local" });
    setView("game");
    setError("");
  }

  async function startRemoteGame() {
    await sendAction("start_game", {});
  }

  async function sendAction(type: string, payload: Record<string, unknown>): Promise<boolean> {
    const current = sessionRef.current;
    if (!current || current.room.code === "DEMO") return false;
    const leaseKey = `ink-and-echo:action:${current.room.code}`;
    const owner = tabIdRef.current || (tabIdRef.current = crypto.randomUUID());
    try {
      const existing = JSON.parse(window.localStorage.getItem(leaseKey) || "null") as {
        owner?: string;
        expiresAt?: number;
      } | null;
      if (existing?.owner && existing.owner !== owner && (existing.expiresAt ?? 0) > Date.now()) {
        setError("This room is already submitting from another tab. We’ll refresh this one instead.");
        wakePollRef.current?.();
        return false;
      }
      window.localStorage.setItem(leaseKey, JSON.stringify({ owner, expiresAt: Date.now() + 15_000 }));
    } catch {
      // Version checks on the server still prevent duplicate commits when storage is unavailable.
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${current.room.code}/actions`, {
        method: "POST",
        headers: roomAuthHeaders(current, true),
        body: JSON.stringify({
          expectedVersion: current.room.version,
          action: { type, ...payload },
        }),
      });
      const body = await readRoomJson(response);
      const nextRoom = normalizeRoom(body);
      applyRoomSnapshot(nextRoom);
      broadcastRef.current?.postMessage({ type: "refresh", version: nextRoom.version });
      return true;
    } catch (cause) {
      wakePollRef.current?.();
      if (cause instanceof RoomApiError && cause.status === 409) {
        setError("That turn already moved on. We’re loading the newest version now.");
      } else {
        setReconnecting(true);
        setError("We could not confirm whether that turn arrived. Your draft is still saved while we check.");
      }
      return false;
    } finally {
      setLoading(false);
      try {
        const lease = JSON.parse(window.localStorage.getItem(leaseKey) || "null") as { owner?: string } | null;
        if (lease?.owner === owner) window.localStorage.removeItem(leaseKey);
      } catch {
        // Lease expiry handles cleanup when storage reads fail.
      }
    }
  }

  function returnHome() {
    setSession(null);
    sessionRef.current = null;
    setView("landing");
    setError("");
    window.history.replaceState({}, "", window.location.pathname);
  }

  async function leaveRoom() {
    const current = sessionRef.current;
    if (!current) {
      returnHome();
      return;
    }
    if (current.room.code !== "DEMO") {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/rooms/${current.room.code}/leave`, {
          method: "POST",
          headers: roomAuthHeaders(current),
        });
        await readRoomJson(response);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "We could not confirm that the room was left. Your recovery key is still saved.");
        setConfirmLeave(false);
        setLoading(false);
        return;
      }
      removeRoomSession(window.localStorage, window.sessionStorage, current.room.code);
      setRecentRooms(listRecoverySessions(window.localStorage));
      setLoading(false);
    }
    setConfirmLeave(false);
    returnHome();
  }

  async function deleteCurrentRoom() {
    const current = sessionRef.current;
    if (!current || current.room.code === "DEMO") {
      returnHome();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${current.room.code}`, {
        method: "DELETE",
        headers: roomAuthHeaders(current),
      });
      await readRoomJson(response);
      removeRoomSession(window.localStorage, window.sessionStorage, current.room.code);
      setRecentRooms(listRecoverySessions(window.localStorage));
      returnHome();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The room could not be deleted yet.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <Header
        roomCode={room?.code}
        onHome={returnHome}
        onHow={() => setShowHow(true)}
        onLeave={room ? () => setConfirmLeave(true) : undefined}
      />

      {reconnecting && (
        <div className="status-banner reconnecting" role="status">
          Reconnecting… your seat and in-progress draft are still saved on this device.
          <button onClick={() => room && void resumeRoom(room.code)}>Try now</button>
        </div>
      )}
      {storageWarning && (
        <div className="status-banner storage" role="status">
          This browser blocked local storage. Keep this tab open; refresh recovery may be limited.
        </div>
      )}

      {error && (
        <div className="toast" role="alert">
          <span>!</span>
          {error}
          <button aria-label="Dismiss message" onClick={() => setError("")}>×</button>
        </div>
      )}

      {view === "landing" && (
        <Landing
          playerName={playerName}
          setPlayerName={setPlayerName}
          onCreate={() => setView("create")}
          onJoin={() => setView("join")}
          onDemo={startPassAndPlay}
          recentRooms={recentRooms}
          loading={loading}
          onResume={(code) => void resumeRoom(code)}
          onMode={(mode) => {
            setSettings((current) => withModeRecipe(current, mode));
            setView("create");
          }}
        />
      )}

      {view === "create" && (
        <CreateRoom
          settings={settings}
          setSettings={setSettings}
          selectedMode={selectedMode}
          loading={loading}
          onBack={() => setView("landing")}
          onCreate={createRoom}
        />
      )}

      {view === "join" && (
        <JoinRoom
          playerName={playerName}
          setPlayerName={setPlayerName}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          loading={loading}
          onJoin={joinRoom}
          onBack={() => setView("landing")}
        />
      )}

      {view === "lobby" && room && session && (
        <Lobby
          room={room}
          me={session.playerId}
          copied={copied}
          onCopy={async () => {
            await navigator.clipboard.writeText(makeInviteUrl(room.code));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          }}
          onCopyResume={session.recoveryToken ? async () => {
            await navigator.clipboard.writeText(makeResumeUrl(room.code, session.playerId, session.recoveryToken!));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          } : undefined}
          onStart={startRemoteGame}
          loading={loading}
        />
      )}

      {view === "game" && room && session && (
        <GameStage
          key={`${room.activePlayerId}-${room.currentTurn?.kind}-${room.currentTurn?.round}`}
          session={session}
          loading={loading}
          onAction={sendAction}
          onLocalRoom={(nextRoom) => setSession({ ...session, room: nextRoom })}
          onGallery={() => setView("gallery")}
        />
      )}

      {view === "gallery" && room && session && (
        <Gallery
          room={room}
          onAgain={returnHome}
          onDelete={room.hostPlayerId === session.playerId ? deleteCurrentRoom : undefined}
          loading={loading}
        />
      )}

      {showHow && <HowToPlay onClose={() => setShowHow(false)} />}
      {confirmLeave && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmLeave(false)}>
          <section className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <span className="mini-label">Leave this room?</span>
            <h2 id="leave-title">Your seat will be released.</h2>
            <p>Your partner can keep the room, and the host role will pass to them. Any unsent draft stays only on this device.</p>
            <div>
              <button className="secondary-button" onClick={() => setConfirmLeave(false)}>Stay here</button>
              <button className="danger-button" disabled={loading} onClick={() => void leaveRoom()}>{loading ? "Leaving…" : "Leave room"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Header({ roomCode, onHome, onHow, onLeave }: { roomCode?: string; onHome: () => void; onHow: () => void; onLeave?: () => void }) {
  return (
    <header className="site-header">
      <button className="brand" onClick={onHome} aria-label="Ink and Echo home">
        <span className="brand-mark" aria-hidden="true"><i /><b /></span>
        <span>ink <em>&</em> echo</span>
      </button>
      <div className="header-actions">
        {roomCode && roomCode !== "DEMO" && <span className="mini-room">room <strong>{roomCode}</strong></span>}
        {onLeave && <button className="leave-button" onClick={onLeave}>Leave room</button>}
        <button className="quiet-button" onClick={onHow}>How it works</button>
      </div>
    </header>
  );
}

function Landing({
  playerName,
  setPlayerName,
  onCreate,
  onJoin,
  onDemo,
  onMode,
  recentRooms,
  loading,
  onResume,
}: {
  playerName: string;
  setPlayerName: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onDemo: () => void;
  onMode: (mode: ModeId) => void;
  recentRooms: StoredRoomSession[];
  loading: boolean;
  onResume: (code: string) => void;
}) {
  return (
    <>
      <section className="hero page-width">
        <div className="hero-copy">
          <div className="eyebrow"><span>2</span> seats, endless plot twists</div>
          <h1>Draw something.<br /><i>Change everything.</i></h1>
          <p>
            A cozy creative game made for exactly two people. Trade prompts, doodles, guesses, and tiny acts of chaos for as many rounds as you want.
          </p>
          <div className="name-field">
            <label htmlFor="player-name">Your doodling name</label>
            <input
              id="player-name"
              value={playerName}
              maxLength={24}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="e.g. Captain Scribble"
              onKeyDown={(event) => event.key === "Enter" && onCreate()}
            />
          </div>
          <div className="hero-actions">
            <button className="primary-button big" onClick={onCreate}>Make a room <span>→</span></button>
            <button className="secondary-button big" onClick={onJoin}>Join a friend</button>
          </div>
           <button className="demo-link" onClick={onDemo}><span>▶</span> Try pass & play on this device</button>
          {recentRooms.length > 0 && (
            <div className="recent-rooms" aria-label="Recent rooms">
              <span className="mini-label">Continue your duet</span>
              {recentRooms.slice(0, 3).map((saved) => (
                <article className="recent-room-card" key={`${saved.code}:${saved.playerId}`}>
                  <div>
                    <strong>{saved.code}</strong>
                    <small>{saved.playerName ? `${saved.playerName} · ` : ""}{saved.phase === "playing" ? "game in progress" : saved.phase ?? "saved seat"}</small>
                  </div>
                  <div className="recent-room-actions">
                    <button className="secondary-button" disabled={loading} onClick={() => onResume(saved.code)}>Resume</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <HeroChain />
      </section>

      <section className="mode-section page-width" aria-labelledby="modes-title">
        <div className="section-heading">
          <div>
            <span className="mini-label">Pick your flavor of chaos</span>
            <h2 id="modes-title">Seven ways to lose the plot</h2>
          </div>
          <p>Every mode is tuned for a duet: quick turns, shared callbacks, and enough rounds for a real inside joke to form.</p>
        </div>
        <div className="mode-grid">
          {MODES.map((mode, index) => (
            <button className={`mode-card accent-${mode.accent}`} key={mode.id} onClick={() => onMode(mode.id)}>
              <span className="mode-number">0{index + 1}</span>
              <span className="mode-icon" aria-hidden="true">{mode.icon}</span>
              <span className="mode-kicker">{mode.kicker}</span>
              <strong>{mode.name}</strong>
              <span>{mode.description}</span>
              <i>Choose mode →</i>
            </button>
          ))}
        </div>
      </section>

      <section className="promise-strip">
        <div className="page-width promise-inner">
          <span><b>2</b> people, on purpose</span>
          <span><b>3–12</b> rounds, your call</span>
          <span><b>0</b> drawing talent required</span>
          <span><b>∞</b> chances to make it weird</span>
        </div>
      </section>
      <p className="privacy-note page-width">
        Online prompts and drawings are stored so both players can reconnect and view the gallery. Waiting rooms expire after 24 hours, active games after 48 hours of inactivity, and finished galleries after 7 days; the host can delete sooner.
      </p>
    </>
  );
}

function HeroChain() {
  return (
    <div className="hero-art" aria-label="An example chain: prompt, drawing, and surprising guess">
      <div className="scribble-loop" aria-hidden="true" />
      <article className="paper-card prompt-paper">
        <span>you wrote</span>
        <p>“A moon walking its pet cloud”</p>
        <i className="tape tape-yellow" />
      </article>
      <article className="paper-card drawing-paper">
        <span>they drew</span>
        <div className="moon-doodle" aria-hidden="true">
          <i className="moon-face" />
          <i className="cloud-puff puff-one" />
          <i className="cloud-puff puff-two" />
          <i className="cloud-puff puff-three" />
          <i className="leash" />
          <b>✦</b><em>·</em>
        </div>
        <i className="tape tape-violet" />
      </article>
      <article className="paper-card guess-paper">
        <span>you guessed</span>
        <p>“A sleepy planet taking laundry outside?”</p>
        <i className="tape tape-coral" />
      </article>
      <div className="tiny-note">close enough! <span>♥</span></div>
    </div>
  );
}

function CreateRoom({
  settings,
  setSettings,
  selectedMode,
  loading,
  onBack,
  onCreate,
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  selectedMode: (typeof MODES)[number];
  loading: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  return (
    <section className="setup-page page-width">
      <button className="back-button" onClick={onBack}>← Back to the cozy part</button>
      <div className="setup-heading">
        <div>
          <span className="mini-label">Room recipe</span>
          <h1>How should tonight unravel?</h1>
        </div>
        <div className={`selected-mode-badge accent-${selectedMode.accent}`}>
          <span>{selectedMode.icon}</span>
          <div><small>Selected mode</small><strong>{selectedMode.name}</strong></div>
        </div>
      </div>

      <div className="setup-layout">
        <div className="settings-card">
          <div className="setting-block">
            <div className="setting-title"><span>01</span><div><strong>Choose a mode</strong><small>Each one changes the rhythm of your turns.</small></div></div>
            <div className="mode-picker">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  className={settings.mode === mode.id ? "active" : ""}
                  onClick={() => setSettings((current) => withModeRecipe(current, mode.id))}
                >
                  <span>{mode.icon}</span>{mode.name}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-block compact">
              <div className="setting-title"><span>02</span><div><strong>Rounds</strong><small>Long enough for a callback.</small></div></div>
              <div className="range-wrap">
                <input
                  aria-label="Number of rounds"
                  type="range"
                  min="3"
                  max="12"
                  value={settings.rounds}
                  onChange={(event) => setSettings((current) => ({ ...current, rounds: Number(event.target.value) }))}
                />
                <output>{settings.rounds}</output>
              </div>
            </div>
            <div className="setting-block compact">
              <div className="setting-title"><span>03</span><div><strong>Turn timer</strong><small>A little pressure, lovingly.</small></div></div>
              <div className="segmented">
                {[20, 30, 60, 90, 120].map((seconds) => (
                  <button
                    key={seconds}
                    className={settings.timerSeconds === seconds ? "active" : ""}
                    onClick={() => setSettings((current) => ({ ...current, timerSeconds: seconds }))}
                  >{seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-block compact">
              <div className="setting-title"><span>04</span><div><strong>Canvas</strong><small>Pick a shape for the story.</small></div></div>
              <div className="canvas-options">
                {(["square", "classic", "wide"] as const).map((size) => (
                  <button key={size} className={settings.canvasSize === size ? "active" : ""} onClick={() => setSettings((c) => ({ ...c, canvasSize: size }))}>
                    <i className={`canvas-shape ${size}`} />{size === "classic" ? "4:3" : size}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-block compact">
              <div className="setting-title"><span>05</span><div><strong>Prompt spark</strong><small>We can break the blank-page silence.</small></div></div>
              <label className="toggle-card">
                <span><strong>Surprise prompts</strong><small>Mix in friendly, funny ideas</small></span>
                <input type="checkbox" checked={settings.randomPrompts} onChange={(event) => setSettings((c) => ({ ...c, randomPrompts: event.target.checked }))} />
                <i />
              </label>
            </div>
          </div>
        </div>

        <aside className="room-summary">
          <span className="summary-sticker">your duet</span>
          <div className={`summary-icon accent-${selectedMode.accent}`}>{selectedMode.icon}</div>
          <h2>{selectedMode.name}</h2>
          <p>{selectedMode.description}</p>
          <dl>
            <div><dt>Players</dt><dd>Exactly 2</dd></div>
            <div><dt>Rounds</dt><dd>{settings.rounds}</dd></div>
            <div><dt>Each turn</dt><dd>{settings.timerSeconds}s</dd></div>
            <div><dt>Canvas</dt><dd>{settings.canvasSize}</dd></div>
          </dl>
          <button className="primary-button full" onClick={onCreate} disabled={loading}>{loading ? "Folding the invite…" : "Create the room →"}</button>
          <small>Your friend joins with a private six-character code.</small>
        </aside>
      </div>
    </section>
  );
}

function JoinRoom({ playerName, setPlayerName, joinCode, setJoinCode, loading, onJoin, onBack }: {
  playerName: string;
  setPlayerName: (value: string) => void;
  joinCode: string;
  setJoinCode: (value: string) => void;
  loading: boolean;
  onJoin: () => void;
  onBack: () => void;
}) {
  return (
    <section className="center-page page-width">
      <button className="back-button" onClick={onBack}>← Back home</button>
      <div className="join-card paper-card-static">
        <span className="large-doodle" aria-hidden="true">↝</span>
        <span className="mini-label">Second seat, best seat</span>
        <h1>Join your drawing partner</h1>
        <p>Paste the code they sent you. No account, no audience, just the two of you.</p>
        <label>Your name<input value={playerName} maxLength={24} onChange={(event) => setPlayerName(event.target.value)} placeholder="What should they call you?" /></label>
        <label>Room code<input className="code-input" value={joinCode} maxLength={6} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ECHO42" onKeyDown={(event) => event.key === "Enter" && onJoin()} /></label>
        <button className="primary-button full" onClick={onJoin} disabled={loading}>{loading ? "Finding the room…" : "Take the second seat →"}</button>
      </div>
    </section>
  );
}

function Lobby({ room, me, copied, onCopy, onCopyResume, onStart, loading }: { room: Room; me: string; copied: boolean; onCopy: () => void; onCopyResume?: () => void; onStart: () => void; loading: boolean }) {
  const amHost = room.hostPlayerId === me || room.players.find((player) => player.id === me)?.isHost;
  const ready = room.players.length === 2;
  return (
    <section className="lobby-page page-width">
      <div className="lobby-copy">
        <span className="mini-label">The calm before the scribble</span>
        <h1>Your room is ready.</h1>
        <p>{ready ? "Both pencils are here. Take a breath, lower your standards, and begin." : "Send this little code to your favorite co-conspirator."}</p>
        <div className="invite-ticket">
          <div><small>Room code</small><strong>{room.code}</strong></div>
          <button onClick={onCopy}>{copied ? "Copied! ♥" : "Copy invite link"}</button>
        </div>
        {onCopyResume && <button className="quiet-button" onClick={onCopyResume}>Copy my private recovery link</button>}
        <div className="player-seats">
          {[0, 1].map((index) => {
            const player = room.players[index];
            return (
              <div className={player ? "seat filled" : "seat waiting"} key={index}>
                <span>{player ? player.name.slice(0, 1).toUpperCase() : "…"}</span>
                <div><small>{index === 0 ? "First pencil" : "Second pencil"}</small><strong>{player?.name ?? "Waiting for your person"}</strong></div>
                {player && <i><span className={`presence-dot ${player.isOnline === false ? "offline" : ""}`} />{player.id === me ? "you" : player.isOnline === false ? "away" : "ready"}</i>}
              </div>
            );
          })}
        </div>
        {amHost ? (
          <button className="primary-button big" disabled={!ready || loading} onClick={onStart}>{!ready ? "Waiting for player two…" : loading ? "Shuffling the prompts…" : "Start the first round →"}</button>
        ) : (
          <div className="waiting-note"><span className="pulse-dot" /> The host will start when you’re both comfy.</div>
        )}
      </div>
      <aside className="lobby-recipe">
        <div className={`summary-icon accent-${modeById(room.settings.mode).accent}`}>{modeById(room.settings.mode).icon}</div>
        <span>Tonight’s recipe</span>
        <h2>{modeById(room.settings.mode).name}</h2>
        <ul>
          <li><b>{room.settings.rounds}</b> rounds</li>
          <li><b>{room.settings.timerSeconds}s</b> turns</li>
          <li><b>{room.settings.randomPrompts ? "Surprise" : "Handmade"}</b> prompts</li>
          <li><b>{room.settings.canvasSize}</b> canvas</li>
        </ul>
        <p>House rule: the less perfect the drawing, the more lovingly it belongs in the final gallery.</p>
      </aside>
    </section>
  );
}

function GameStage({ session, loading, onAction, onLocalRoom, onGallery }: {
  session: Session;
  loading: boolean;
  onAction: (type: string, payload: Record<string, unknown>) => Promise<boolean>;
  onLocalRoom: (room: Room) => void;
  onGallery: () => void;
}) {
  const { room, playerId } = session;
  const active = room.activePlayerId ?? room.currentTurn?.playerId;
  const isMyTurn = room.code === "DEMO" || !active || active === playerId;
  const currentPlayer = room.players.find((player) => player.id === active);
  const mode = modeById(room.settings.mode);
  const [timerExpired, setTimerExpired] = useState(false);
  const [customClue, setCustomClue] = useState("");

  return (
    <section className="game-page page-width">
      <div className="game-topbar">
        <div className="mode-chip"><span>{mode.icon}</span><div><small>Mode</small><strong>{mode.name}</strong></div></div>
        <RoundProgress current={(room.turnIndex ?? 0) + 1} total={room.totalTurns ?? room.settings.rounds} />
        <Timer
          key={`${room.turnIndex}-${active}-${room.currentTurn?.kind}-${room.currentTurn?.deadlineAt ?? "relaxed"}`}
          seconds={room.settings.timerSeconds}
          deadlineAt={room.currentTurn?.deadlineAt}
          serverNow={room.serverNow}
          onExpire={() => {
            if (isMyTurn) setTimerExpired(true);
          }}
        />
      </div>
      {isMyTurn ? (
        <TurnWorkspace key={`${room.turnIndex}-${active}-${room.currentTurn?.kind}`} room={room} playerId={playerId} loading={loading} timerExpired={timerExpired} onAction={onAction} onLocalRoom={onLocalRoom} onGallery={onGallery} />
      ) : (
        <div className="partner-wait paper-card-static">
          <div className="thinking-doodle" aria-hidden="true"><i /><i /><i /></div>
          <span className="mini-label">Pencil is across the table</span>
          <h1>{currentPlayer?.name ?? "Your partner"} is making a choice.</h1>
          <p>{currentPlayer?.isOnline === false ? "They seem to be away, but their seat is reserved and the game will wait for the next server-timed beat." : "No peeking. This is a good moment to predict how wonderfully wrong the next thing will be."}</p>
          {room.currentTurn?.canAddClue && (
            <div className="clue-composer">
              <label>
                <span>Send a vague clue</span>
                <input
                  value={customClue}
                  maxLength={80}
                  placeholder="Think: tiny, nocturnal, dramatic…"
                  onChange={(event) => setCustomClue(event.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={!customClue.trim() || loading}
                onClick={() => void onAction("add_clue", { text: customClue.trim() }).then((sent) => sent && setCustomClue(""))}
              >Send clue</button>
            </div>
          )}
          <div className="waiting-note"><span className={`presence-dot ${currentPlayer?.isOnline === false ? "offline" : ""}`} /> {currentPlayer?.isOnline === false ? "Partner is reconnecting" : "Their turn is live"}</div>
        </div>
      )}
    </section>
  );
}

function RoundProgress({ current, total }: { current: number; total: number }) {
  const bounded = Math.min(current, total);
  return (
    <div className="round-progress">
      <div><small>Little journey</small><strong>Round {bounded} of {total}</strong></div>
      <div className="progress-dots" aria-label={`Round ${bounded} of ${total}`}>
        {Array.from({ length: total }, (_, index) => <i key={index} className={index < bounded ? "done" : index === bounded ? "current" : ""} />)}
      </div>
    </div>
  );
}

function Timer({ seconds, deadlineAt, serverNow, onExpire }: { seconds: number; deadlineAt?: number; serverNow?: number; onExpire?: () => void }) {
  const [left, setLeft] = useState(seconds);
  const leftRef = useRef(seconds);
  const firedRef = useRef(false);
  const clockOffsetRef = useRef(0);
  useEffect(() => {
    clockOffsetRef.current = serverNow ? serverNow - Date.now() : 0;
    const update = () => {
      const next = deadlineAt
        ? Math.max(0, Math.ceil((deadlineAt - (Date.now() + clockOffsetRef.current)) / 1000))
        : Math.max(0, leftRef.current - 1);
      leftRef.current = next;
      setLeft(next);
      if (next === 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    };
    const initialSync = window.setTimeout(() => {
      if (deadlineAt) update();
    }, 0);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(initialSync);
      window.clearInterval(timer);
    };
  }, [deadlineAt, onExpire, serverNow]);
  const minutes = Math.floor(left / 60);
  const remaining = String(left % 60).padStart(2, "0");
  return <div className={`turn-timer ${left <= 10 ? "urgent" : ""}`}><small>Gentle panic</small><strong>{minutes}:{remaining}</strong></div>;
}

function TurnWorkspace({ room, playerId, loading, timerExpired, onAction, onLocalRoom, onGallery }: {
  room: Room;
  playerId: string;
  loading: boolean;
  timerExpired: boolean;
  onAction: (type: string, payload: Record<string, unknown>) => Promise<boolean>;
  onLocalRoom: (room: Room) => void;
  onGallery: () => void;
}) {
  const turn = room.currentTurn ?? { kind: "prompt" as const, round: 1, instruction: "Plant the first idea." };
  const [text, setText] = useState(turn.prompt ?? "");
  const [memoryVisible, setMemoryVisible] = useState(turn.kind === "memory" && Boolean(turn.previousImage));
  const [memorySeconds, setMemorySeconds] = useState(6);
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const latestDrawingRef = useRef("");
  const autoSubmittedRef = useRef(false);
  const draftSaveTimerRef = useRef<number | undefined>(undefined);
  const [draftReady, setDraftReady] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const isDrawing = ["draw", "memory", "remix", "blind-draw"].includes(turn.kind);
  const draftKey = turnDraftKey(room.code, playerId, roomTurnSignature(room));
  const clockOffsetRef = useRef(0);

  useEffect(() => {
    clockOffsetRef.current = room.serverNow ? room.serverNow - Date.now() : 0;
  }, [room.serverNow]);

  useEffect(() => {
    const shouldPreview = turn.kind === "memory" && Boolean(turn.previousImage);
    if (!shouldPreview) return;
    const update = () => {
      setMemorySeconds((seconds) => {
        const next = turn.revealUntil
          ? Math.max(0, Math.ceil((turn.revealUntil - (Date.now() + clockOffsetRef.current)) / 1000))
          : Math.max(0, seconds - 1);
        if (next <= 0) {
          setMemoryVisible(false);
          return 0;
        }
        return next;
      });
    };
    const initialSync = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(initialSync);
      window.clearInterval(timer);
    };
  }, [room.turnIndex, turn.kind, turn.previousImage, turn.revealUntil]);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const saved = await readTurnDraft(draftKey);
      if (cancelled) return;
      if (saved?.text && !isDrawing) setText(saved.text);
      if (saved?.imageData && isDrawing && !memoryVisible && canvasRef.current) {
        try {
          const parsed = JSON.parse(saved.imageData) as unknown;
          await canvasRef.current.loadDraft(parsed as Parameters<DrawingCanvasHandle["loadDraft"]>[0]);
          if (!cancelled) setDraftNote("Recovered your in-progress sketch.");
        } catch {
          try {
            await canvasRef.current.loadDataUrl(saved.imageData);
            if (!cancelled) setDraftNote("Recovered your in-progress sketch.");
          } catch {
            if (!cancelled) setDraftNote("This old sketch draft could not be restored safely.");
          }
        }
      } else if (saved?.text && !cancelled) {
        setDraftNote("Recovered your in-progress words.");
      }
      if (!cancelled) setDraftReady(true);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [draftKey, isDrawing, memoryVisible]);

  useEffect(() => {
    if (!draftReady || isDrawing) return;
    const timer = window.setTimeout(() => {
      void saveTurnDraft({ key: draftKey, text, updatedAt: Date.now() });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draftKey, draftReady, isDrawing, text]);

  useEffect(() => () => window.clearTimeout(draftSaveTimerRef.current), []);

  const saveDrawingDraftSoon = useCallback(() => {
    if (!draftReady) return;
    window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const saved = await canvasRef.current?.saveDraft();
          if (!saved) return;
          const ok = await saveTurnDraft({
            key: draftKey,
            imageData: JSON.stringify(saved),
            updatedAt: Date.now(),
          });
          if (!ok) setDraftNote("This browser could not save the draft locally.");
        } catch {
          setDraftNote("This browser could not save the latest sketch locally.");
        }
      })();
    }, 450);
  }, [draftKey, draftReady]);

  const advanceDemo = useCallback((entry: GalleryEntry) => {
    const gallery = [...(room.gallery ?? []), entry];
    const nextIndex = (room.turnIndex ?? 0) + 1;
    if (nextIndex >= room.settings.rounds) {
      onLocalRoom({ ...room, phase: "gallery", gallery, turnIndex: nextIndex, currentTurn: null });
      onGallery();
      return;
    }
    const nextPlayerId = room.activePlayerId === "demo-a" ? "demo-b" : "demo-a";
    const lastDrawing = [...gallery].reverse().find((item) => item.imageData);
    const lastText = [...gallery].reverse().find((item) => item.text);
    const mode = room.settings.mode;
    let kind: CurrentTurn["kind"] = nextIndex % 2 === 1 ? "draw" : "guess";
    if (mode === "memory-drift") kind = nextIndex === 1 ? "draw" : "memory";
    if (mode === "blind-prompt") kind = nextIndex % 2 === 1 ? "blind-draw" : "prompt";
    if (mode === "remix-mode") kind = nextIndex === 1 ? "draw" : "remix";
    if (mode === "story-canvas") kind = nextIndex % 2 === 1 ? "draw" : "caption";
    const rule = kind === "remix" ? DEMO_REMIX_RULES[(nextIndex - 2) % DEMO_REMIX_RULES.length] : undefined;
    const instruction = kind === "draw"
      ? mode === "story-canvas" ? "Draw the next panel from the last caption." : "Draw only what the last words suggest."
      : kind === "guess"
        ? "Name the mysterious thing you see."
        : kind === "memory"
          ? "Look closely, then recreate this drawing from memory."
          : kind === "blind-draw"
            ? "Draw from the clue without seeing the full prompt."
            : kind === "remix"
              ? "Keep the old idea and obey the new remix rule."
              : kind === "caption"
                ? "Caption this as the next beat of your tiny story."
                : "Plant the next strange little idea.";
    onLocalRoom({
      ...room,
      version: room.version + 1,
      activePlayerId: nextPlayerId,
      turnIndex: nextIndex,
      gallery,
      currentTurn: {
        kind,
        round: nextIndex + 1,
        playerId: nextPlayerId,
        previousText: kind === "blind-draw" ? undefined : lastText?.text,
        previousImage: lastDrawing?.imageData,
        prompt: kind === "draw" ? lastText?.text : kind === "prompt" && room.settings.randomPrompts ? DEMO_PROMPTS[nextIndex % DEMO_PROMPTS.length] : undefined,
        clue: kind === "blind-draw" ? "It has a very recognizable silhouette." : undefined,
        rule,
        instruction,
      },
    });
  }, [onGallery, onLocalRoom, room]);

  async function submitText() {
    if (!text.trim()) return;
    if (room.code === "DEMO") {
      advanceDemo({ round: turn.round, kind: turn.kind, playerId, playerName: room.players.find((p) => p.id === room.activePlayerId)?.name, text: text.trim() });
      await deleteTurnDraft(draftKey);
    } else {
      const sent = await onAction("submit_text", { text: text.trim(), kind: turn.kind });
      if (sent) await deleteTurnDraft(draftKey);
    }
  }

  async function submitDrawing() {
    setDraftNote("Preparing a lightweight copy…");
    const exported = await canvasRef.current?.exportCompressed({
      type: "image/webp",
      quality: 0.86,
      minQuality: 0.5,
      // Base64 adds roughly one third; this stays below the server's 1.5M-character data-URL cap.
      maxBytes: 1_100_000,
      maxDimension: 1080,
      allowResize: true,
    });
    if (exported && !exported.withinLimit) {
      setDraftNote("This drawing is still too large to send. Try clearing a photo-like background or simplifying the canvas.");
      return;
    }
    const imageData = exported?.dataUrl || latestDrawingRef.current;
    if (!imageData) return;
    if (room.code === "DEMO") {
      advanceDemo({
        round: turn.round,
        kind: turn.kind,
        playerId: room.activePlayerId ?? playerId,
        playerName: room.players.find((player) => player.id === room.activePlayerId)?.name,
        imageData,
        rule: turn.rule,
      });
      await deleteTurnDraft(draftKey);
    } else {
      const sent = await onAction("submit_drawing", { imageData, kind: turn.kind, rule: turn.rule });
      if (sent) await deleteTurnDraft(draftKey);
    }
  }

  useEffect(() => {
    if (
      !timerExpired ||
      autoSubmittedRef.current
    ) {
      return;
    }
    autoSubmittedRef.current = true;
    const autoSubmit = window.setTimeout(() => {
      if (room.code === "DEMO") {
        if (room.settings.mode !== "speed-chaos") return;
        if (isDrawing) {
          advanceDemo({
            round: turn.round,
            kind: turn.kind,
            playerId,
            playerName: room.players.find((player) => player.id === room.activePlayerId)?.name,
            imageData: latestDrawingRef.current || DEMO_EMPTY_DRAWING,
          });
        } else {
          advanceDemo({
            round: turn.round,
            kind: turn.kind,
            playerId,
            playerName: room.players.find((player) => player.id === room.activePlayerId)?.name,
            text: text.trim() || "A very fast mystery!",
          });
        }
        return;
      }
      void onAction("expire_turn", {});
    }, 0);
    return () => window.clearTimeout(autoSubmit);
  }, [advanceDemo, isDrawing, onAction, playerId, room.activePlayerId, room.code, room.players, room.settings.mode, text, timerExpired, turn.kind, turn.round]);

  if (isDrawing) {
    if (memoryVisible && turn.previousImage) {
      return (
        <div className="workspace-card memory-preview">
          <TurnBrief turn={{ ...turn, instruction: "Look closely. This disappears in a moment." }} />
          <div className="memory-frame">
            <img src={turn.previousImage} alt="Drawing to remember" />
            <span>{memorySeconds}</span>
          </div>
          <button className="secondary-button" onClick={() => setMemoryVisible(false)}>I’ve got it — hide it now</button>
        </div>
      );
    }
    const dimensions = room.settings.canvasSize === "square"
      ? { width: 900, height: 900 }
      : room.settings.canvasSize === "wide"
        ? { width: 1080, height: 610 }
        : { width: 960, height: 720 };
    const startingImage = turn.kind === "remix" ? turn.previousImage : null;
    return (
      <div className="workspace-card drawing-workspace">
        <TurnBrief turn={turn} />
        <DrawingCanvas
          key={`${room.turnIndex}-${turn.kind}`}
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          initialImageDataUrl={startingImage}
          initialBackgroundColor="#fffdf8"
          onChange={(dataUrl) => {
            latestDrawingRef.current = dataUrl;
            saveDrawingDraftSoon();
          }}
          disabled={loading}
          downloadFileName={`ink-and-echo-round-${turn.round}.png`}
          ariaLabel={`Drawing canvas for round ${turn.round}`}
        />
        <div className="drawing-submit-row">
          <span><kbd>P</kbd> pen · <kbd>E</kbd> erase · <kbd>⌘Z</kbd> undo · touch friendly</span>
          {draftNote && <small className="draft-note" role="status">{draftNote}</small>}
          {turn.kind === "blind-draw" && (
            <button className="secondary-button" disabled={loading} onClick={() => {
              if (room.code === "DEMO") {
                onLocalRoom({
                  ...room,
                  version: room.version + 1,
                  currentTurn: turn.clue?.includes("silhouette")
                    ? { ...turn, clue: "Its mood is more dramatic than practical." }
                    : { ...turn, clue: "One small detail is doing most of the storytelling." },
                });
                return;
              }
              void onAction("add_clue", {});
            }}>One more clue</button>
          )}
          <button className="primary-button" onClick={submitDrawing} disabled={loading}>{loading ? "Passing the sketch…" : "Send this masterpiece →"}</button>
        </div>
      </div>
    );
  }

  const label = turn.kind === "guess" ? "Your best guess" : turn.kind === "caption" ? "The next caption" : "Your opening prompt";
  const placeholder = turn.kind === "guess" ? "It looks exactly like…" : turn.kind === "caption" ? "Meanwhile, our hero…" : "A tiny wizard arguing with a vending machine…";
  return (
    <div className="workspace-card text-workspace">
      <TurnBrief turn={turn} />
      {turn.previousImage && <img className="reference-drawing" src={turn.previousImage} alt="Your partner's drawing to interpret" />}
      <label className="big-text-entry">
        <span>{label}</span>
        <textarea value={text} maxLength={180} onChange={(event) => setText(event.target.value)} placeholder={placeholder} autoFocus />
        <small>{text.length}/180</small>
      </label>
      <div className="workspace-actions">
        <span>{draftNote || "There are no wrong answers. Only future callbacks."}</span>
        <button className="primary-button" onClick={submitText} disabled={!text.trim() || loading}>{loading ? "Passing it over…" : "Lock it in →"}</button>
      </div>
    </div>
  );
}

function TurnBrief({ turn }: { turn: CurrentTurn }) {
  return (
    <div className="turn-brief">
      <div><span className="mini-label">Your turn</span><h1>{turn.instruction ?? "Add the next little twist."}</h1></div>
      {(turn.rule || turn.clue) && <div className="rule-card"><small>{turn.rule ? "Remix rule" : "Clue unlocked"}</small><strong>{turn.rule ?? turn.clue}</strong></div>}
      {turn.duoBeat && <div className="duo-beat-card"><span>♥</span><div><small>Duo beat · optional</small><strong>{turn.duoBeat}</strong></div></div>}
      {(turn.prompt || turn.previousText) && <blockquote><small>What you know</small><p>{turn.prompt ?? turn.previousText}</p></blockquote>}
    </div>
  );
}

function Gallery({ room, onAgain, onDelete, loading }: { room: Room; onAgain: () => void; onDelete?: () => Promise<void>; loading: boolean }) {
  const entries = room.gallery ?? [];
  const mode = modeById(room.settings.mode);
  function downloadEntry(entry: GalleryEntry, index: number) {
    if (!entry.imageData) return;
    const link = document.createElement("a");
    link.href = entry.imageData;
    link.download = `ink-and-echo-round-${index + 1}.png`;
    link.click();
  }
  function exportStory() {
    const blob = new Blob([JSON.stringify({ title: "Ink & Echo", mode: mode.name, entries }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ink-and-echo-${room.code.toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <section className="gallery-page page-width">
      <div className="gallery-hero">
        <span className="mini-label">The beautiful evidence</span>
        <h1>Look how far the idea wandered.</h1>
        <p>{entries.length ? `${entries.length} tiny choices, two imaginations, and one chain worth keeping.` : "Your finished chain will collect here, one tiny turn at a time."}</p>
        <div><button className="primary-button" onClick={() => window.print()}>Print gallery</button><button className="secondary-button" onClick={exportStory}>Export story</button></div>
      </div>
      <div className="gallery-chain">
        {entries.map((entry, index) => (
          <article className={`gallery-entry ${entry.imageData ? "image-entry" : "text-entry"}`} key={entry.id ?? `${index}-${entry.kind}`}>
            <div className="gallery-meta"><span>Round {index + 1}</span><b>{entry.kind.replace("-", " ")}</b><small>{entry.playerName ?? room.players.find((p) => p.id === entry.playerId)?.name}</small></div>
            {entry.imageData ? <button className="gallery-image" onClick={() => downloadEntry(entry, index)} title="Download this drawing"><img src={entry.imageData} alt={`Round ${index + 1} drawing`} /><span>↓ save image</span></button> : <blockquote>{entry.text}</blockquote>}
            {entry.rule && <p className="gallery-rule">Rule: {entry.rule}</p>}
            {index < entries.length - 1 && <i className="chain-arrow">↓</i>}
          </article>
        ))}
        {!entries.length && <div className="empty-gallery">No turns yet — your first inside joke is still warming up.</div>}
      </div>
      <div className="gallery-footer">
        <span>Thanks for making something strange together. ♥</span>
        <div>
          {onDelete && <button className="danger-button" disabled={loading} onClick={() => window.confirm("Permanently delete this room and its gallery?") && void onDelete()}>{loading ? "Deleting…" : "Delete room"}</button>}
          <button className="primary-button big" onClick={onAgain}>Back home →</button>
        </div>
      </div>
    </section>
  );
}

function HowToPlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="how-modal" role="dialog" aria-modal="true" aria-labelledby="how-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <span className="mini-label">A duet in four beats</span>
        <h2 id="how-title">How Ink & Echo works</h2>
        <ol>
          <li><span>1</span><div><strong>Make a tiny room</strong><p>Choose a mode, timer, and 3–12 rounds. The room always has exactly two seats.</p></div></li>
          <li><span>2</span><div><strong>Trade the creative baton</strong><p>You might prompt, draw, remember, remix, guess, or caption. Instructions stay clear and short.</p></div></li>
          <li><span>3</span><div><strong>Let the idea drift</strong><p>Each turn sees only what the mode allows. That little gap is where the funny part lives.</p></div></li>
          <li><span>4</span><div><strong>Keep the whole story</strong><p>At the end, reveal every step in a shared gallery and save the drawings you love.</p></div></li>
        </ol>
        <button className="primary-button full" onClick={onClose}>I’m ready to make a mess</button>
      </section>
    </div>
  );
}
