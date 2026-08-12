import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory localStorage polyfill for Node — storage.js only uses
// getItem/setItem/removeItem, so this is enough to exercise it for real.
class MemoryStorage {
  constructor() { this._map = new Map(); }
  getItem(key) { return this._map.has(key) ? this._map.get(key) : null; }
  setItem(key, value) { this._map.set(key, String(value)); }
  removeItem(key) { this._map.delete(key); }
  clear() { this._map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const storage = await import('../js/storage.js');
const { SCHEMA_VERSION } = await import('../js/constants.js');

function validGameState(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    gameId: 'game-abc123',
    seed: 42,
    status: 'active',
    difficulty: 'operator',
    startedAt: new Date().toISOString(),
    elapsedSeconds: 0,
    lastResumedAtMs: Date.now(),
    budgetInitialCents: 1000000,
    budgetRemainingCents: 900000,
    actionsAllowedTotal: 5,
    actionsRemaining: 4,
    network: {
      transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
      nodes: [
        { id: 'TS-01', x: 0, y: 0, kind: 'source' },
        { id: 'N01', x: 1, y: 0, kind: 'load' }
      ],
      edges: [{ id: 'VOD01', fromNodeId: 'TS-01', toNodeId: 'N01', cableTypeId: 'nyy-4x25', lengthKm: 0.2, allowShorten: false, interventions: {} }],
      loads: [{ id: 'L01', nodeId: 'N01', name: 'Test', pW: 5000, cosPhi: 0.9, priority: true, connected: true, compensationSteps: 0 }]
    },
    scenario: { id: 'seed-42', title: 'Test', description: 'Test', events: [] },
    actionHistory: [],
    calculated: { alarms: [], score: 1000 },
    outcome: null,
    ...overrides
  };
}

test('save then load active game round-trips exactly', () => {
  globalThis.localStorage.clear();
  const state = validGameState();
  storage.saveActiveGame(state);
  const result = storage.loadActiveGame();
  assert.equal(result.found, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.state, state);
});

test('export then import produces an identical, valid state', () => {
  const state = validGameState({ gameId: 'game-roundtrip' });
  const json = storage.exportGameToJsonString(state);
  const imported = storage.parseImportedGameJson(json);
  assert.equal(imported.valid, true);
  assert.deepEqual(imported.state, state);
});

test('importing corrupted JSON fails gracefully with a controlled error, no throw', () => {
  const result = storage.parseImportedGameJson('{ this is not valid json ][');
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('importing a well-formed but schema-invalid JSON is rejected with explanatory errors', () => {
  const badState = validGameState();
  badState.network.loads[0].cosPhi = 5; // out of (0,1] range
  delete badState.gameId;
  const result = storage.parseImportedGameJson(JSON.stringify(badState));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('cosPhi')));
  assert.ok(result.errors.some((e) => e.includes('gameId')));
});

test('importing a network containing a cycle is rejected', () => {
  const badState = validGameState();
  badState.network.nodes.push({ id: 'N02', x: 2, y: 0, kind: 'load' });
  badState.network.edges.push({ id: 'VOD02', fromNodeId: 'N01', toNodeId: 'N02', cableTypeId: 'nyy-4x25', lengthKm: 0.1, allowShorten: false, interventions: {} });
  badState.network.edges.push({ id: 'VOD03', fromNodeId: 'TS-01', toNodeId: 'N02', cableTypeId: 'nyy-4x25', lengthKm: 0.1, allowShorten: false, interventions: {} }); // creates a cycle
  const result = storage.parseImportedGameJson(JSON.stringify(badState));
  assert.equal(result.valid, false);
});

test('a malicious import (XSS payload in a name field) is accepted only as inert text, never executed', () => {
  // storage/validation layer does not execute anything — it only validates
  // shape and stores strings as data. The actual XSS defence is that the
  // renderer (renderer-svg.js / inspector.js) uses textContent exclusively.
  // Here we just confirm the payload string survives as plain, un-parsed text.
  const state = validGameState();
  state.network.loads[0].name = '<img src=x onerror=alert(1)>';
  const json = storage.exportGameToJsonString(state);
  const imported = storage.parseImportedGameJson(json);
  assert.equal(imported.valid, true);
  assert.equal(imported.state.network.loads[0].name, '<img src=x onerror=alert(1)>');
  assert.equal(typeof imported.state.network.loads[0].name, 'string');
});

test('a failed import does not clear or touch the existing saved active game', () => {
  globalThis.localStorage.clear();
  const goodState = validGameState({ gameId: 'game-keep-me' });
  storage.saveActiveGame(goodState);

  const badResult = storage.parseImportedGameJson('not json at all {{{');
  assert.equal(badResult.valid, false);

  const stillThere = storage.loadActiveGame();
  assert.equal(stillThere.valid, true);
  assert.equal(stillThere.state.gameId, 'game-keep-me');
});

test('corrupted localStorage content (bad JSON) is reported, not thrown', () => {
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem('gridfix.activeGame.v1', '{corrupted');
  const result = storage.loadActiveGame();
  assert.equal(result.found, true);
  assert.equal(result.valid, false);
});

test('history is capped and newest entries stay at the front', () => {
  globalThis.localStorage.clear();
  for (let i = 0; i < 55; i++) {
    storage.appendHistory({ gameId: `g${i}`, result: 'won', score: i });
  }
  const history = storage.getHistory();
  assert.ok(history.length <= 50);
  assert.equal(history[0].gameId, 'g54');
});

test('high scores stay sorted descending and capped', () => {
  globalThis.localStorage.clear();
  for (const score of [10, 900, 300, 50, 1200, 700, 20, 999, 1, 2, 3]) {
    storage.submitHighScore({ gameId: `g${score}`, score });
  }
  const scores = storage.getHighScores();
  assert.ok(scores.length <= 10);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1].score >= scores[i].score);
  }
});

test('resetAllLocalData clears every known key', () => {
  storage.saveActiveGame(validGameState());
  storage.appendHistory({ gameId: 'x' });
  storage.submitHighScore({ gameId: 'x', score: 1 });
  storage.resetAllLocalData();
  assert.equal(storage.loadActiveGame().found, false);
  assert.deepEqual(storage.getHistory(), []);
  assert.deepEqual(storage.getHighScores(), []);
});
