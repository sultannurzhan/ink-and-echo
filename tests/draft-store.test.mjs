import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { saveTurnDraft, readTurnDraft, deleteTurnDraft } from '../lib/client/draft-store.ts';

function setup() {
  const values = new Map();
  globalThis.indexedDB = new IDBFactory();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return values;
}

test('a fallback draft remains recoverable when IndexedDB starts working again', async () => {
  setup();
  const draft = { key: 'fallback', text: 'A moon with a scarf', updatedAt: 100 };
  globalThis.indexedDB = { open() { throw new Error('unavailable'); } };
  assert.equal(await saveTurnDraft(draft), true);
  globalThis.indexedDB = new IDBFactory();
  assert.deepEqual(await readTurnDraft(draft.key), draft);
});

test('a newer fallback draft wins over an older IndexedDB copy', async () => {
  const values = setup();
  await saveTurnDraft({ key: 'newest', text: 'old', updatedAt: 100 });
  const latest = { key: 'newest', text: 'new', updatedAt: 200 };
  values.set('ink-and-echo:draft:newest', JSON.stringify(latest));
  assert.deepEqual(await readTurnDraft('newest'), latest);
  await deleteTurnDraft('newest');
  assert.equal(await readTurnDraft('newest'), null);
});

test('a transaction abort after request success is not reported as a saved draft', async () => {
  setup();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  try {
    assert.equal(await saveTurnDraft({ key: 'abort', text: 'keep me', updatedAt: 1 }), false);
  } finally {
    IDBObjectStore.prototype.put = original;
  }
});
