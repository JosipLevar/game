import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateIntervention } from '../js/engine/interventions.js';
import { ACTION_TYPES } from '../js/constants.js';
import { LIMITS } from '../js/constants.js';

const cablesById = {
  weak: { id: 'weak', resistanceOhmPerKm: 1.15, maxCurrentA: 80, costPerKmCents: 900000 },
  strong: { id: 'strong', resistanceOhmPerKm: 0.2, maxCurrentA: 300, costPerKmCents: 2600000 }
};
const transformersById = {
  't-small': { id: 't-small', ratedPowerKVA: 100 },
  't-big': { id: 't-big', ratedPowerKVA: 400 }
};

function baseNetwork() {
  return {
    transformer: { id: 'TS-01', ratedPowerKVA: 100, upgraded: false },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'junction' },
      { id: 'N02', x: 2, y: 0, kind: 'load' },
      { id: 'N03', x: 2, y: 1, kind: 'load' }
    ],
    edges: [
      { id: 'VOD01', fromNodeId: 'TS-01', toNodeId: 'N01', cableTypeId: 'weak', lengthKm: 0.2, allowShorten: true, interventions: { cableReplaced: false, shortened: false } },
      { id: 'VOD02', fromNodeId: 'N01', toNodeId: 'N02', cableTypeId: 'weak', lengthKm: 0.2, allowShorten: false, interventions: { cableReplaced: false, shortened: false } },
      { id: 'VOD03', fromNodeId: 'N01', toNodeId: 'N03', cableTypeId: 'weak', lengthKm: 0.2, allowShorten: false, interventions: { cableReplaced: false, shortened: false } }
    ],
    loads: [
      { id: 'L02', nodeId: 'N02', name: 'A', pW: 3000, cosPhi: 0.9, priority: false, connected: true, compensationSteps: 0 },
      { id: 'L03', nodeId: 'N03', name: 'B', pW: 3000, cosPhi: 0.9, priority: true, connected: true, compensationSteps: 0 }
    ]
  };
}

const ctx = { cablesById, transformersById, limits: LIMITS };

test('replace cable only changes the targeted edge', () => {
  const network = baseNetwork();
  const result = simulateIntervention(network, ACTION_TYPES.REPLACE_CABLE,
    { edgeId: 'VOD02', newCableTypeId: 'strong' }, ctx);
  assert.equal(result.valid, true);
  const e2 = result.network.edges.find((e) => e.id === 'VOD02');
  const e1 = result.network.edges.find((e) => e.id === 'VOD01');
  const e3 = result.network.edges.find((e) => e.id === 'VOD03');
  assert.equal(e2.cableTypeId, 'strong');
  assert.equal(e1.cableTypeId, 'weak', 'untouched edge must be unaffected');
  assert.equal(e3.cableTypeId, 'weak', 'untouched edge must be unaffected');
  // Original network object passed in must not be mutated.
  assert.equal(network.edges.find((e) => e.id === 'VOD02').cableTypeId, 'weak');
});

test('replace cable cannot be applied twice to the same edge', () => {
  const network = baseNetwork();
  network.edges[1].interventions.cableReplaced = true;
  const result = simulateIntervention(network, ACTION_TYPES.REPLACE_CABLE,
    { edgeId: 'VOD02', newCableTypeId: 'strong' }, ctx);
  assert.equal(result.valid, false);
});

test('cannot disconnect a priority load', () => {
  const network = baseNetwork();
  const result = simulateIntervention(network, ACTION_TYPES.DISCONNECT_LOAD, { loadId: 'L03' }, ctx);
  assert.equal(result.valid, false);
});

test('can disconnect a non-priority load', () => {
  const network = baseNetwork();
  const result = simulateIntervention(network, ACTION_TYPES.DISCONNECT_LOAD, { loadId: 'L02' }, ctx);
  assert.equal(result.valid, true);
  assert.equal(result.network.loads.find((l) => l.id === 'L02').connected, false);
});

test('transfer load rejects a move that would create a cycle', () => {
  const network = baseNetwork();
  // Moving N01 (the junction, parent of N02/N03) to attach under its own child N02
  // must be rejected — N01 would become its own descendant.
  const result = simulateIntervention(network, ACTION_TYPES.TRANSFER_LOAD,
    { nodeId: 'N01', targetParentNodeId: 'N02' }, ctx);
  assert.equal(result.valid, false);
});

test('transfer load accepts moving a leaf to a different, unrelated node', () => {
  const network = baseNetwork();
  const result = simulateIntervention(network, ACTION_TYPES.TRANSFER_LOAD,
    { nodeId: 'N03', targetParentNodeId: 'N02' }, ctx);
  assert.equal(result.valid, true);
});

test('action blocked when it would exceed remaining budget', () => {
  const network = baseNetwork();
  const poorCtx = { ...ctx, budgetRemainingCents: 100 }; // essentially nothing
  const result = simulateIntervention(network, ACTION_TYPES.UPGRADE_TRANSFORMER,
    { newTransformerId: 't-big' }, poorCtx);
  assert.equal(result.valid, false);
});

test('action blocked when no actions remain', () => {
  const network = baseNetwork();
  const noActionsCtx = { ...ctx, actionsRemaining: 0 };
  const result = simulateIntervention(network, ACTION_TYPES.ADD_COMPENSATION, { loadId: 'L02' }, noActionsCtx);
  assert.equal(result.valid, false);
});

test('transformer upgrade only once per round', () => {
  const network = baseNetwork();
  const first = simulateIntervention(network, ACTION_TYPES.UPGRADE_TRANSFORMER, { newTransformerId: 't-big' }, ctx);
  assert.equal(first.valid, true);
  const second = simulateIntervention(first.network, ACTION_TYPES.UPGRADE_TRANSFORMER, { newTransformerId: 't-big' }, ctx);
  assert.equal(second.valid, false);
});
