import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStoryArchive, storyArchive } from '../lib/client/story-archive.ts';
import { resolveApiUrl } from '../lib/client/api-url.ts';
import { preflight, withApiHeaders } from '../worker/http-policy.ts';
import { browserStorage, saveActiveCredentials } from '../lib/client/room-session.ts';
import { roomFetch, readRoomSnapshot, isConfirmedInvalidAuth } from '../lib/client/room-transport.ts';
import http from 'node:http';

test('malformed successful room responses fail safely without invalidating saved credentials', () => {
  for (const payload of [{}, {room:{}}, {room:{code:'ABCDEF',version:1,phase:'playing',players:[],settings:{mode:'classic-chain',rounds:3,timerSeconds:30}}}]) {
    assert.throws(() => readRoomSnapshot(payload), error => error.status === 502 && !isConfirmedInvalidAuth(error));
  }
  const room={code:'ABCDEF',version:1,phase:'lobby',players:[{id:'p',name:'Fictional Host'}],settings:{mode:'classic-chain',rounds:3,timerSeconds:30}};
  assert.equal(readRoomSnapshot({room}),room);
});

test('room requests time out instead of leaving the interface busy forever', async () => {
  const server=http.createServer(() => {});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(roomFetch(`http://127.0.0.1:${server.address().port}`,{},30),error=>error.name==='TimeoutError');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('legacy gallery exports round-trip without private room credentials', () => {
  const legacy = { title: 'Ink & Echo', mode: 'Classic Chain', playerToken: 'secret', entries: [
    { round: 1, kind: 'prompt', text: '<script>just text</script>', playerName: 'Fictional player', recoveryToken: 'secret' },
  ] };
  const imported = parseStoryArchive(JSON.stringify(legacy));
  assert.equal(imported.entries[0].text, legacy.entries[0].text);
  assert.equal(JSON.stringify(imported).includes('secret'), false);
  assert.deepEqual(storyArchive(imported.mode, imported.entries), imported);
});

test('story import rejects malformed schemas, remote URLs and executable image types', () => {
  for (const value of [null, {}, {title: 'Ink & Echo', version: 2, entries: []},
    {title:'Ink & Echo', entries:[{round:1, kind:'draw', imageData:'https://example.com/tracker.png'}]},
    {title:'Ink & Echo', entries:[{round:1, kind:'draw', imageData:'data:image/svg+xml,<svg/>'}]},
    {title:'Ink & Echo', entries:[{round:0, kind:'prompt', text:'x'}]},
  ]) assert.throws(() => parseStoryArchive(JSON.stringify(value)));
  assert.throws(() => parseStoryArchive('{bad json'));
});

test('expired legacy placeholders remain timeouts when imported', () => {
  const archive = parseStoryArchive(JSON.stringify({title:'Ink & Echo', entries:[
    {round:1,kind:'draw',imageData:'legacy black placeholder',metadata:{expired:true}},
  ]}));
  assert.equal(archive.entries[0].imageData, undefined);
  assert.equal(archive.entries[0].metadata.expired, true);
});

test('Pages uses the configured API origin without changing repository asset paths', () => {
  assert.equal(resolveApiUrl('/api/rooms/ABCDEF', 'https://example.workers.dev'), 'https://example.workers.dev/api/rooms/ABCDEF');
  assert.equal(resolveApiUrl('/api/rooms', ''), '/api/rooms');
  assert.throws(() => resolveApiUrl('/api/rooms', '', true), /connected game server/);
  for(const origin of ['http://remote.example', 'https://u:secret@example.com', 'https://example.com/path']) {
    assert.throws(() => resolveApiUrl('/api/rooms', origin));
  }
});

test('CORS allows only the configured Pages origin, including conditional poll responses', () => {
  const allowed = 'https://sultannurzhan.github.io';
  const request = new Request('https://api.example/api/rooms', { method: 'OPTIONS', headers:{Origin:allowed} });
  const response = preflight(request, allowed);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), allowed);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(preflight(new Request(request,{headers:{Origin:'https://other.example'}}), allowed).status, 403);
  const unchanged = withApiHeaders(new Response(null,{status:304}), request, allowed);
  assert.equal(unchanged.headers.get('cache-control'),'no-store');
  assert.equal(unchanged.headers.get('access-control-allow-origin'),allowed);
});

test('a throwing browser storage getter degrades safely and reports failed persistence', () => {
  globalThis.window = {};
  Object.defineProperty(window,'localStorage',{get(){throw new Error('denied');}});
  const storage=browserStorage('local');
  assert.equal(storage.getItem('anything'),null);
  assert.equal(saveActiveCredentials(storage,'ABCDEF',{playerId:'p',playerToken:'t'}),false);
  delete globalThis.window;
});
