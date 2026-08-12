import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this._map = new Map(); }
  getItem(key) { return this._map.has(key) ? this._map.get(key) : null; }
  setItem(key, value) { this._map.set(key, String(value)); }
  removeItem(key) { this._map.delete(key); }
}
globalThis.localStorage = new MemoryStorage();

const { createInitialGameState } = await import('../js/state.js');
const { simulateIntervention } = await import('../js/engine/interventions.js');
const { computeScore, evaluateWinCondition, evaluateLossCondition } = await import('../js/engine/scoring.js');
const { ACTION_TYPES, LIMITS } = await import('../js/constants.js');
const storage = await import('../js/storage.js');

const cablesById = {
  weak: { id: 'weak', name: 'Slab kabel', resistanceOhmPerKm: 1.15, maxCurrentA: 80, costPerKmCents: 900000, tier: 1 },
  strong: { id: 'strong', name: 'Jak kabel', resistanceOhmPerKm: 0.2, maxCurrentA: 300, costPerKmCents: 2600000, tier: 5 }
};
const transformersById = { 't-250': { id: 't-250', ratedPowerKVA: 250 } };

function singleFaultNetwork() {
  return {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'load' }
    ],
    edges: [{ id: 'VOD01', fromNodeId: 'TS-01', toNodeId: 'N01', cableTypeId: 'weak', lengthKm: 0.3, allowShorten: false, interventions: { cableReplaced: false, shortened: false } }],
    loads: [{ id: 'L01', nodeId: 'N01', name: 'Test potrošač', pW: 65000, cosPhi: 0.9, priority: true, connected: true, compensationSteps: 0 }]
  };
}
/** Mirrors app.js's commitIntervention() state transition exactly, using only engine functions. */
function commit(prevState, actionType, params) {
  const ctx = {
    cablesById, transformersById, limits: LIMITS,
    budgetRemainingCents: prevState.budgetRemainingCents,
    actionsRemaining: prevState.actionsRemaining
  };
  const result = simulateIntervention(prevState.network, actionType, params, ctx);
  if (!result.valid) return { committed: false, errors: result.errors, state: prevState };

  const newBudgetRemaining = prevState.budgetRemainingCents - result.costCents;
  const newActionsRemaining = prevState.actionsRemaining - 1;
  const actionsUsed = prevState.actionsAllowedTotal - newActionsRemaining;
  const scoreNow = computeScore({
    network: result.network, calculated: result.calculated,
    budgetInitialCents: prevState.budgetInitialCents, budgetRemainingCents: newBudgetRemaining, actionsUsed
  });
  let nextState = {
    ...prevState,
    network: result.network,
    calculated: { ...result.calculated, score: scoreNow },
    budgetRemainingCents: newBudgetRemaining,
    actionsRemaining: newActionsRemaining,
    actionHistory: [...prevState.actionHistory, { actionType, params, costCents: result.costCents }]
  };
  const winEval = evaluateWinCondition({
    network: nextState.network, calculated: nextState.calculated,
    budgetRemainingCents: nextState.budgetRemainingCents, actionsRemaining: nextState.actionsRemaining
  });
  if (winEval.won) {
    nextState = { ...nextState, status: 'won', outcome: { result: 'won', finalScore: scoreNow } };
  } else if (evaluateLossCondition({ winEvaluation: winEval, budgetRemainingCents: nextState.budgetRemainingCents, actionsRemaining: nextState.actionsRemaining })) {
    nextState = { ...nextState, status: 'lost', outcome: { result: 'lost', finalScore: scoreNow, reasons: winEval.reasons } };
  }
  return { committed: true, state: nextState };
}

test('winning on the LAST available action reports a win, not a loss', async () => {
  const { computeLoadFlow } = await import('../js/engine/load-flow.js');
  const network = singleFaultNetwork();
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.ok(calc.alarms.some((a) => a.severity === 'critical'), 'sanity: network must start broken');

  let state = createInitialGameState({
    seed: 1, difficultyId: 'projektant', budgetInitialCents: 10_000_000, actionsAllowed: 1,
    network, scenario: { id: 's', title: 'Test', description: '', events: [] }, calculated: calc, score: 0
  });
  assert.equal(state.actionsRemaining, 1, 'this is the LAST action available');

  const outcome = commit(state, ACTION_TYPES.REPLACE_CABLE, { edgeId: 'VOD01', newCableTypeId: 'strong' });
  assert.equal(outcome.committed, true);
  assert.equal(outcome.state.actionsRemaining, 0, 'no actions left after this move');
  assert.equal(outcome.state.status, 'won', 'fixing the last fault on the last move must be a WIN, not a loss');
});

test('running out of actions while still broken is a loss', async () => {
  const { computeLoadFlow } = await import('../js/engine/load-flow.js');
  const network = singleFaultNetwork();
  const calc = computeLoadFlow(network, cablesById, LIMITS);

  let state = createInitialGameState({
    seed: 2, difficultyId: 'projektant', budgetInitialCents: 10_000_000, actionsAllowed: 1,
    network, scenario: { id: 's', title: 'Test', description: '', events: [] }, calculated: calc, score: 0
  });

  // Spend the only action on something that does NOT fix the fault (add compensation
  // to a load whose problem is cable overload, not power factor — legal action, useless fix).
  const outcome = commit(state, ACTION_TYPES.ADD_COMPENSATION, { loadId: 'L01' });
  assert.equal(outcome.committed, true);
  assert.equal(outcome.state.actionsRemaining, 0);
  assert.equal(outcome.state.status, 'lost', 'no actions left and still broken must be a loss');
});

test('an action blocked by insufficient budget is never recorded in history', async () => {
  const { computeLoadFlow } = await import('../js/engine/load-flow.js');
  const network = singleFaultNetwork();
  const calc = computeLoadFlow(network, cablesById, LIMITS);

  let state = createInitialGameState({
    seed: 3, difficultyId: 'projektant', budgetInitialCents: 1000, actionsAllowed: 5, // essentially no money
    network, scenario: { id: 's', title: 'Test', description: '', events: [] }, calculated: calc, score: 0
  });
  state = { ...state, budgetRemainingCents: 1000 };

  const outcome = commit(state, ACTION_TYPES.REPLACE_CABLE, { edgeId: 'VOD01', newCableTypeId: 'strong' });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.state.actionHistory.length, 0, 'a rejected action must not appear in actionHistory');
  assert.equal(outcome.state.actionsRemaining, 5, 'a rejected action must not consume an action slot');
});

test('save -> reload -> resume produces the identical network and score ("refresh the page")', async () => {
  const { computeLoadFlow } = await import('../js/engine/load-flow.js');
  const network = singleFaultNetwork();
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  const state = createInitialGameState({
    seed: 4, difficultyId: 'operator', budgetInitialCents: 5_000_000, actionsAllowed: 5,
    network, scenario: { id: 's', title: 'Test', description: '', events: [] }, calculated: calc, score: 500
  });

  storage.saveActiveGame(state);
  const reloaded = storage.loadActiveGame();
  assert.equal(reloaded.valid, true);
  assert.deepEqual(reloaded.state.network, state.network);
  assert.deepEqual(reloaded.state.calculated, state.calculated);
  assert.equal(reloaded.state.calculated.score, 500);
});

test('export -> import produces an identical state ready to keep playing', async () => {
  const { computeLoadFlow } = await import('../js/engine/load-flow.js');
  const network = singleFaultNetwork();
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  const state = createInitialGameState({
    seed: 5, difficultyId: 'operator', budgetInitialCents: 5_000_000, actionsAllowed: 5,
    network, scenario: { id: 's', title: 'Test', description: '', events: [] }, calculated: calc, score: 500
  });

  const exported = storage.exportGameToJsonString(state);
  const imported = storage.parseImportedGameJson(exported);
  assert.equal(imported.valid, true);
  assert.deepEqual(imported.state.network, state.network);
  assert.equal(imported.state.gameId, state.gameId);
});
