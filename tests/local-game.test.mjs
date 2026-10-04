import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalRoom, advanceLocalRoom, addLocalClue } from '../lib/client/local-game.ts';

for (const [mode,firstKind,turns] of [
  ['classic-chain','prompt',6],['guess-evolution','prompt',6],['speed-chaos','draw',6],
  ['memory-drift','draw',7],['remix-mode','draw',7],['story-canvas','draw',12],['blind-prompt','prompt',12],
]) test(`pass & play preserves ${mode} opening, actor alternation, and round cadence`, () => {
  let room=createLocalRoom({mode,rounds:6,timerSeconds:60,randomPrompts:false,canvasSize:'classic'},'A',1000);
  assert.equal(room.currentTurn.kind,firstKind);
  let previous;
  for(let i=0;i<turns;i++) {
    assert.equal(room.phase,'playing');
    // Blind Prompt alternates roles by paired round: the drawer writes the next target.
    if(mode !== 'blind-prompt' || i % 2 === 1) assert.notEqual(room.activePlayerId,previous);
    previous=room.activePlayerId;
    const kind=room.currentTurn.kind;
    room=advanceLocalRoom(room,{round:room.currentTurn.round,kind,text:['prompt','guess','caption'].includes(kind)?'Fictional comet':undefined,imageData:['prompt','guess','caption'].includes(kind)?undefined:'fixture'},2000+i*1000);
  }
  assert.equal(room.phase,'gallery');
  assert.equal(room.gallery.length,turns);
  assert.equal(room.currentTurn,null);
});

test('local Blind Prompt gives relevant hints while hiding target text', () => {
  let room=createLocalRoom({mode:'blind-prompt',rounds:3,timerSeconds:60,randomPrompts:false,canvasSize:'classic'},'A',1000);
  room=advanceLocalRoom(room,{round:1,kind:'prompt',text:'Silver comet'},2000);
  assert.equal(room.currentTurn.prompt,undefined);
  assert.equal(room.currentTurn.previousText,undefined);
  assert.match(room.currentTurn.clue,/2 words/);
  room=addLocalClue(room,3000);
  assert.match(room.currentTurn.clue,/“S”/);
});

test('new local games have distinct draft identities and classic chain resets after a guess', () => {
  const settings={mode:'classic-chain',rounds:6,timerSeconds:60,randomPrompts:false,canvasSize:'classic'};
  let room=createLocalRoom(settings,'A',1000);
  assert.notEqual(room.localGameId,createLocalRoom(settings,'A',1000).localGameId);
  for(const kind of ['prompt','draw','guess'])room=advanceLocalRoom(room,{round:1,kind,text:'An idea'},2000);
  assert.equal(room.currentTurn.kind,'prompt');
  assert.equal(room.currentTurn.previousImage,undefined);
});
