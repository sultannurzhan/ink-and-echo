"use client";
/* eslint-disable @next/next/no-img-element -- Player-created data URLs cannot use Next image optimization. */

import { useEffect, useRef, useState } from "react";
import { DrawingCanvas, type DrawingCanvasHandle } from "@/components/DrawingCanvas";

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

type Player = { id: string; name: string; isHost?: boolean };
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
};
type Room = {
  code: string;
  phase: "lobby" | "playing" | "gallery" | "finished";
  version: number;
  hostPlayerId?: string;
  activePlayerId?: string;
  turnIndex?: number;
  totalTurns?: number;
  settings: Settings;
  players: Player[];
  currentTurn?: CurrentTurn | null;
  gallery?: GalleryEntry[];
};
type Session = { room: Room; playerId: string; playerToken: string };

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

const ROOM_SESSION_PREFIX = "ink-and-echo:room:";

function normalizeRoom(value: unknown): Room {
  const body = value as { room?: Room } & Room;
  return body.room ?? body;
}

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || "Something went sideways. Please try again.");
  }
  return body as Record<string, unknown>;
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

function rememberRoomSession(session: Session) {
  if (typeof window === "undefined" || session.room.code === "DEMO") return;
  window.localStorage.setItem(
    `${ROOM_SESSION_PREFIX}${session.room.code}`,
    JSON.stringify({
      code: session.room.code,
      playerId: session.playerId,
      playerToken: session.playerToken,
    }),
  );
}

function forgetRoomSession(code?: string) {
  if (typeof window === "undefined" || !code || code === "DEMO") return;
  window.localStorage.removeItem(`${ROOM_SESSION_PREFIX}${code}`);
}

function viewForRoom(room: Room): View {
  if (room.phase === "playing") return "game";
  if (room.phase === "gallery" || room.phase === "finished") return "gallery";
  return "lobby";
}

export function GameApp() {
  const [view, setView] = useState<View>("landing");
  const [playerName, setPlayerName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const pollFailureCount = useRef(0);

  const room = session?.room;
  const selectedMode = modeById(settings.mode);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room")?.toUpperCase();
    if (!code) return;
    let cancelled = false;
    const revealInvite = window.setTimeout(() => {
      void (async () => {
        const fallbackToJoin = () => {
          if (cancelled) return;
          setJoinCode(code);
          setView("join");
          setLoading(false);
        };
        const saved = window.localStorage.getItem(`${ROOM_SESSION_PREFIX}${code}`);
        if (!saved) {
          fallbackToJoin();
          return;
        }
        try {
          const credentials = JSON.parse(saved) as { playerId?: string; playerToken?: string };
          if (!credentials.playerId || !credentials.playerToken) throw new Error("Incomplete room session");
          setLoading(true);
          const query = new URLSearchParams({
            playerId: credentials.playerId,
            playerToken: credentials.playerToken,
          });
          const response = await fetch(`/api/rooms/${code}?${query}`, { cache: "no-store" });
          const body = await readJson(response);
          if (cancelled) return;
          const restored: Session = {
            room: normalizeRoom(body),
            playerId: credentials.playerId,
            playerToken: credentials.playerToken,
          };
          setSession(restored);
          setView(viewForRoom(restored.room));
          setLoading(false);
        } catch {
          forgetRoomSession(code);
          fallbackToJoin();
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(revealInvite);
    };
  }, []);

  useEffect(() => {
    if (
      !session ||
      session.room.code === "DEMO" ||
      session.room.phase === "gallery" ||
      session.room.phase === "finished"
    ) return;
    const interval = window.setInterval(async () => {
      try {
        const query = new URLSearchParams({
          playerId: session.playerId,
          playerToken: session.playerToken,
          sinceVersion: String(session.room.version),
        });
        const response = await fetch(`/api/rooms/${session.room.code}?${query}`, { cache: "no-store" });
        if (response.status === 304) return;
        const body = await readJson(response);
        const nextRoom = normalizeRoom(body);
        setSession((current) => (current ? { ...current, room: nextRoom } : current));
        pollFailureCount.current = 0;
        if (nextRoom.phase === "playing") setView("game");
        if (nextRoom.phase === "gallery" || nextRoom.phase === "finished") setView("gallery");
      } catch {
        pollFailureCount.current += 1;
        if (pollFailureCount.current > 4) setError("The room is taking a nap. Trying to reconnect…");
      }
    }, 900);
    return () => window.clearInterval(interval);
  }, [session]);

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
      const body = await readJson(response);
      const next: Session = {
        room: normalizeRoom(body),
        playerId: String(body.playerId),
        playerToken: String(body.playerToken),
      };
      setSession(next);
      rememberRoomSession(next);
      window.history.replaceState({}, "", `?room=${next.room.code}`);
      setView("lobby");
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
      const body = await readJson(response);
      const next: Session = {
        room: normalizeRoom(body),
        playerId: String(body.playerId),
        playerToken: String(body.playerToken),
      };
      setSession(next);
      rememberRoomSession(next);
      window.history.replaceState({}, "", `?room=${next.room.code}`);
      setView(next.room.phase === "playing" ? "game" : "lobby");
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

  async function sendAction(type: string, payload: Record<string, unknown>) {
    if (!session) return;
    if (session.room.code === "DEMO") return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${session.room.code}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: session.playerId,
          playerToken: session.playerToken,
          expectedVersion: session.room.version,
          action: { type, ...payload },
        }),
      });
      const body = await readJson(response);
      const nextRoom = normalizeRoom(body);
      setSession((current) => (current ? { ...current, room: nextRoom } : current));
      if (nextRoom.phase === "playing") setView("game");
      if (nextRoom.phase === "gallery" || nextRoom.phase === "finished") setView("gallery");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That turn did not arrive. Try once more.");
    } finally {
      setLoading(false);
    }
  }

  function leaveRoom() {
    forgetRoomSession(session?.room.code);
    setSession(null);
    setView("landing");
    setError("");
    window.history.replaceState({}, "", window.location.pathname);
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <Header roomCode={room?.code} onHome={leaveRoom} onHow={() => setShowHow(true)} />

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

      {view === "gallery" && room && <Gallery room={room} onAgain={leaveRoom} />}

      {showHow && <HowToPlay onClose={() => setShowHow(false)} />}
    </main>
  );
}

function Header({ roomCode, onHome, onHow }: { roomCode?: string; onHome: () => void; onHow: () => void }) {
  return (
    <header className="site-header">
      <button className="brand" onClick={onHome} aria-label="Ink and Echo home">
        <span className="brand-mark" aria-hidden="true"><i /><b /></span>
        <span>ink <em>&</em> echo</span>
      </button>
      <div className="header-actions">
        {roomCode && roomCode !== "DEMO" && <span className="mini-room">room <strong>{roomCode}</strong></span>}
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
}: {
  playerName: string;
  setPlayerName: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onDemo: () => void;
  onMode: (mode: ModeId) => void;
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

function Lobby({ room, me, copied, onCopy, onStart, loading }: { room: Room; me: string; copied: boolean; onCopy: () => void; onStart: () => void; loading: boolean }) {
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
        <div className="player-seats">
          {[0, 1].map((index) => {
            const player = room.players[index];
            return (
              <div className={player ? "seat filled" : "seat waiting"} key={index}>
                <span>{player ? player.name.slice(0, 1).toUpperCase() : "…"}</span>
                <div><small>{index === 0 ? "First pencil" : "Second pencil"}</small><strong>{player?.name ?? "Waiting for your person"}</strong></div>
                {player && <i>{player.id === me ? "you" : "ready"}</i>}
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
  onAction: (type: string, payload: Record<string, unknown>) => Promise<void>;
  onLocalRoom: (room: Room) => void;
  onGallery: () => void;
}) {
  const { room, playerId } = session;
  const active = room.activePlayerId ?? room.currentTurn?.playerId;
  const isMyTurn = room.code === "DEMO" || !active || active === playerId;
  const currentPlayer = room.players.find((player) => player.id === active);
  const mode = modeById(room.settings.mode);
  const [timerExpired, setTimerExpired] = useState(false);

  return (
    <section className="game-page page-width">
      <div className="game-topbar">
        <div className="mode-chip"><span>{mode.icon}</span><div><small>Mode</small><strong>{mode.name}</strong></div></div>
        <RoundProgress current={(room.turnIndex ?? 0) + 1} total={room.totalTurns ?? room.settings.rounds} />
        <Timer
          key={`${room.turnIndex}-${active}-${room.currentTurn?.kind}-${room.currentTurn?.deadlineAt ?? "relaxed"}`}
          seconds={room.settings.timerSeconds}
          deadlineAt={room.currentTurn?.deadlineAt}
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
          <p>No peeking. This is a good moment to predict how wonderfully wrong the next thing will be.</p>
          <div className="waiting-note"><span className="pulse-dot" /> Their turn is live</div>
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

function Timer({ seconds, deadlineAt, onExpire }: { seconds: number; deadlineAt?: number; onExpire?: () => void }) {
  const [left, setLeft] = useState(seconds);
  const leftRef = useRef(seconds);
  const firedRef = useRef(false);
  useEffect(() => {
    const update = () => {
      const next = deadlineAt
        ? Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000))
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
  }, [deadlineAt, onExpire]);
  const minutes = Math.floor(left / 60);
  const remaining = String(left % 60).padStart(2, "0");
  return <div className={`turn-timer ${left <= 10 ? "urgent" : ""}`}><small>Gentle panic</small><strong>{minutes}:{remaining}</strong></div>;
}

function TurnWorkspace({ room, playerId, loading, timerExpired, onAction, onLocalRoom, onGallery }: {
  room: Room;
  playerId: string;
  loading: boolean;
  timerExpired: boolean;
  onAction: (type: string, payload: Record<string, unknown>) => Promise<void>;
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

  useEffect(() => {
    const shouldPreview = turn.kind === "memory" && Boolean(turn.previousImage);
    if (!shouldPreview) return;
    const update = () => {
      setMemorySeconds((seconds) => {
        const next = turn.revealUntil
          ? Math.max(0, Math.ceil((turn.revealUntil - Date.now()) / 1000))
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

  function advanceDemo(entry: GalleryEntry) {
    const gallery = [...(room.gallery ?? []), entry];
    const nextIndex = (room.turnIndex ?? 0) + 1;
    if (nextIndex >= room.settings.rounds) {
      onLocalRoom({ ...room, phase: "gallery", gallery, turnIndex: nextIndex, currentTurn: null });
      onGallery();
      return;
    }
    const nextPlayerId = room.activePlayerId === "demo-a" ? "demo-b" : "demo-a";
    const last = gallery[gallery.length - 1];
    const kind: CurrentTurn["kind"] = nextIndex % 2 === 1 ? "draw" : "guess";
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
        previousText: last.text,
        previousImage: last.imageData,
        prompt: kind === "draw" ? last.text : undefined,
        instruction: kind === "draw" ? "Draw only what the last words suggest." : "Name the mysterious thing you see.",
      },
    });
  }

  async function submitText() {
    if (!text.trim()) return;
    if (room.code === "DEMO") {
      advanceDemo({ round: turn.round, kind: turn.kind, playerId, playerName: room.players.find((p) => p.id === room.activePlayerId)?.name, text: text.trim() });
    } else {
      await onAction("submit_text", { text: text.trim(), kind: turn.kind });
    }
  }

  async function submitDrawing() {
    const imageData = canvasRef.current?.exportDataUrl() || latestDrawingRef.current;
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
    } else {
      await onAction("submit_drawing", { imageData, kind: turn.kind, rule: turn.rule });
    }
  }

  const isDrawing = ["draw", "memory", "remix", "blind-draw"].includes(turn.kind);
  useEffect(() => {
    if (
      !timerExpired ||
      room.settings.mode !== "speed-chaos" ||
      room.code === "DEMO" ||
      autoSubmittedRef.current
    ) {
      return;
    }
    autoSubmittedRef.current = true;
    const autoSubmit = window.setTimeout(() => {
      if (isDrawing) {
        const imageData = canvasRef.current?.exportDataUrl() || latestDrawingRef.current;
        if (imageData) {
          void onAction("submit_drawing", { imageData, kind: turn.kind, rule: turn.rule });
        }
      } else {
        void onAction("submit_text", {
          text: text.trim() || "A very fast mystery!",
          kind: turn.kind,
        });
      }
    }, 0);
    return () => window.clearTimeout(autoSubmit);
  }, [isDrawing, onAction, room.code, room.settings.mode, text, timerExpired, turn.kind, turn.rule]);

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
          }}
          disabled={loading}
          downloadFileName={`ink-and-echo-round-${turn.round}.png`}
          ariaLabel={`Drawing canvas for round ${turn.round}`}
        />
        <div className="drawing-submit-row">
          <span><kbd>P</kbd> pen · <kbd>E</kbd> erase · <kbd>⌘Z</kbd> undo · touch friendly</span>
          {turn.kind === "blind-draw" && (
            <button className="secondary-button" disabled={loading} onClick={() => onAction("add_clue", {})}>One more clue</button>
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
        <span>There are no wrong answers. Only future callbacks.</span>
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

function Gallery({ room, onAgain }: { room: Room; onAgain: () => void }) {
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
      <div className="gallery-footer"><span>Thanks for making something strange together. ♥</span><button className="primary-button big" onClick={onAgain}>Make another chain →</button></div>
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
