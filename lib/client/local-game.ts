import {
  initialGameState, advanceAfterText, advanceAfterDrawing, addBlindClue, normalizeSettings,
  isDrawingTurn, type StoredGameState,
} from "../server/room-game.ts";
import type { Room, Settings, GalleryEntry, CurrentTurn } from "./game-types.ts";

function project(room: Room, state: StoredGameState, now: number): Room {
  const turn = state.currentTurn;
  const source = room.gallery?.find((entry) => entry.id === turn?.sourceEntryId);
  const kindMap = { drawing: "draw", "seed-drawing": "draw", "memory-drawing": "memory", "blind-drawing": "blind-draw" } as const;
  const kind = turn ? (kindMap[turn.kind as keyof typeof kindMap] ?? turn.kind) as CurrentTurn["kind"] : undefined;
  const visible = turn?.kind !== "blind-drawing" ? source : undefined;
  return {
    ...room, localState: state, phase: turn ? "playing" : "gallery",
    activePlayerId: turn?.actorPlayerId, turnNumber: state.turnNumber,
    turnIndex: Math.max(0, state.round - 1), totalTurns: room.settings.rounds, serverNow: now,
    currentTurn: turn && kind ? {
      kind, round: Math.max(1, state.round), playerId: turn.actorPlayerId,
      instruction: turn.instruction, prompt: turn.suggestedPrompt ?? visible?.text,
      previousText: visible?.text, previousImage: visible?.imageData,
      sourceEntryId: turn.sourceEntryId, rule: turn.rule, clue: turn.clues?.at(-1),
      deadlineAt: turn.deadlineAt, revealUntil: turn.revealUntil,
    } : null,
  };
}

export function createLocalRoom(input: Settings, playerName: string, now = Date.now()): Room {
  const settings=normalizeSettings(input);
  const room: Room={code:"DEMO",localGameId:crypto.randomUUID(),phase:"playing",version:1,settings,
    hostPlayerId:"demo-a",players:[{id:"demo-a",name:playerName,isHost:true},{id:"demo-b",name:"Doodler Two"}],gallery:[]};
  return project(room,initialGameState(settings,"demo-a",now),now);
}

export function advanceLocalRoom(room: Room, entry: GalleryEntry, now = Date.now()): Room {
  const state=room.localState;
  if(!state?.currentTurn) throw new Error("This local game has no active turn.");
  const actor=state.currentTurn.actorPlayerId;
  const id=crypto.randomUUID();
  const players=room.players.map((p,i)=>({...p,seat:i as 0|1}));
  const args={settings:room.settings,state,players,actorPlayerId:actor,entryId:id,now};
  const next=isDrawingTurn(state.currentTurn.kind)
    ? advanceAfterDrawing(args)
    : advanceAfterText({...args,text:entry.text??""});
  const submitted={...entry,id,playerId:actor,playerName:players.find(p=>p.id===actor)?.name};
  return project({...room,version:room.version+1,gallery:[...(room.gallery??[]),submitted]},next.state,now);
}

export function addLocalClue(room: Room, now = Date.now()): Room {
  if(!room.localState?.currentTurn) return room;
  const next=addBlindClue({settings:room.settings,state:room.localState,actorPlayerId:room.localState.currentTurn.actorPlayerId,text:"",now});
  return project({...room,version:room.version+1},next,now);
}
