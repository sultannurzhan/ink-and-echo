import assert from 'node:assert/strict';
import test from 'node:test';

const base = process.env.INK_TEST_API || 'http://127.0.0.1:8787';
if(new URL(base).hostname !== '127.0.0.1' && process.env.INK_ALLOW_LIVE_TEST !== 'ink-and-echo') throw new Error('Explicit opt-in required for live synthetic rooms.');
async function request(path, method = 'GET', payload, auth) {
  const response = await fetch(base+path, {method, headers:{'content-type':'application/json',
    ...(auth?{authorization:`Bearer ${auth.playerToken}`,'x-player-id':auth.playerId}:{}),
  }, body:payload === undefined?undefined:JSON.stringify(payload), signal:AbortSignal.timeout(15_000)});
  const body=response.status===304?null:await response.json();
  return {status:response.status,body,headers:response.headers};
}
const roomOf=r=>r.body.room??r.body;
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=';

test('real API: two seats, auth, concurrent handoff, gallery, recovery rotation and leave', async () => {
  const created=await request('/api/rooms','POST',{playerName:'Audit Host',settings:{mode:'classic-chain',rounds:3,timerSeconds:180,randomPrompts:false}});
  assert.equal(created.status,201);
  const host=created.body, code=host.room.code, path=`/api/rooms/${code}`;
  const joined=await request(path+'/join','POST',{playerName:'Audit Guest'});
  assert.equal(joined.status,201);
  const guest=joined.body;
  assert.equal((await request(path+'/join','POST',{playerName:'Third seat'})).status,409);
  assert.equal((await request(path)).status,401);
  assert.equal((await request(path+`?playerId=${host.playerId}&playerToken=${host.playerToken}`)).status,401);
  const action=(auth,version,type,payload={})=>request(path+'/actions','POST',{expectedVersion:version,action:{type,...payload}},auth);
  assert.equal((await action(guest,guest.room.version,'start_game')).status,403);
  let started=await action(host,guest.room.version,'start_game');
  assert.equal(started.status,200);
  let current=roomOf(started);
  const duplicate=await Promise.all([action(host,current.version,'submit_text',{text:'A fictional cloud'}),action(host,current.version,'submit_text',{text:'A fictional cloud'})]);
  assert.deepEqual(duplicate.map(r=>r.status).sort(),[200,409]);
  current=roomOf(duplicate.find(r=>r.status===200));
  assert.equal((await action(guest,current.version,'submit_drawing',{imageData:'data:image/svg+xml,<svg/>'})).status,400);
  const drawing=await action(guest,current.version,'submit_drawing',{imageData:pixel});
  assert.equal(drawing.status,200);
  current=roomOf(drawing);
  const finished=await action(host,current.version,'submit_text',{text:'A fluffy spaceship'});
  assert.equal(finished.status,200);
  const gallery=roomOf(finished);
  assert.equal(gallery.phase,'gallery'); assert.equal(gallery.gallery.length,3);
  const reloaded=await request(path,'GET',undefined,host);
  assert.deepEqual(roomOf(reloaded).gallery,gallery.gallery);
  const conditional=await request(path+`?sinceVersion=${gallery.version}&sincePresenceVersion=${roomOf(reloaded).presenceVersion}`,'GET',undefined,host);
  assert.equal(conditional.status,304); assert.equal(conditional.headers.get('cache-control'),'no-store');
  const recovered=await request(path+'/recover','POST',{playerId:host.playerId,recoveryToken:host.recoveryToken});
  assert.equal(recovered.status,200);
  assert.equal((await request(path,'GET',undefined,host)).status,401);
  assert.equal((await request(path+'/recover','POST',{playerId:host.playerId,recoveryToken:host.recoveryToken})).status,401);
  assert.equal((await request(path+'/leave','POST',undefined,recovered.body)).status,200);
  assert.equal((await request(path+'/leave','POST',undefined,recovered.body)).status,200);
  assert.equal(roomOf(await request(path,'GET',undefined,guest)).hostPlayerId,guest.playerId);
  // Synthetic test gallery is retained under normal expiry, never erase arbitrary live rooms.
});

test('real API: Blind Prompt redacts the target and expired turns advance', async () => {
  const created=await request('/api/rooms','POST',{playerName:'Audit Clue',settings:{mode:'blind-prompt',rounds:1,timerSeconds:10,randomPrompts:false}});
  assert.equal(created.status,201);
  const host=created.body,path=`/api/rooms/${host.room.code}`;
  const guest=(await request(path+'/join','POST',{playerName:'Audit Drawer'})).body;
  let result=await request(path+'/actions','POST',{expectedVersion:guest.room.version,action:{type:'start_game'}},host);
  const target='Secret turquoise teapot';
  result=await request(path+'/actions','POST',{expectedVersion:roomOf(result).version,action:{type:'submit_text',text:target}},host);
  assert.equal(result.status,200);
  const view=await request(path,'GET',undefined,guest);
  assert.equal(JSON.stringify(view.body).includes(target),false);
  assert.equal(roomOf(view).currentTurn.kind,'blind-draw');
  await new Promise(resolve=>setTimeout(resolve,26_000));
  const expired=await request(path,'GET',undefined,guest);
  assert.equal(roomOf(expired).phase,'gallery');
  assert.equal(roomOf(expired).gallery.at(-1).metadata.expired,true);
  assert.equal(roomOf(expired).gallery.at(-1).imageData,null);
});
