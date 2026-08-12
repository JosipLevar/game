import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoadFlow, effectiveCosPhi } from '../js/engine/load-flow.js';
import { LIMITS } from '../js/constants.js';

const TEST_CABLE = { id: 'test-cable', resistanceOhmPerKm: 1, maxCurrentA: 100 };
const cablesById = { 'test-cable': TEST_CABLE };

function approxEqual(actual, expected, epsilon = 0.05, msg = '') {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${msg} expected ${expected}, got ${actual} (Δ=${Math.abs(actual - expected)})`);
}

function makeLoad(id, nodeId, pW, cosPhi, overrides = {}) {
  return { id, nodeId, name: id, pW, cosPhi, priority: false, connected: true, compensationSteps: 0, ...overrides };
}

function makeEdge(id, from, to, lengthKm, overrides = {}) {
  return { id, fromNodeId: from, toNodeId: to, cableTypeId: 'test-cable', lengthKm, allowShorten: false, interventions: {}, ...overrides };
}

test('single line, single load: current, voltage drop and losses match hand calc', () => {
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'load' }
    ],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.5)],
    loads: [makeLoad('L01', 'N01', 10000, 0.8)]
  };
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.equal(calc.valid, true);

  // Hand calc: Q = 10000*tan(acos(0.8)) = 7500 var; S=12500 VA
  // I = 12500 / (sqrt3*400) = 18.042 A
  approxEqual(calc.edgeCurrents.VOD01, 18.042, 0.01, 'current');
  // R = 1*0.5 = 0.5 ohm; deltaU = sqrt3*I*R*cosPhi = sqrt3*18.042*0.5*0.8
  approxEqual(calc.edgeDeltaUV.VOD01, 12.497, 0.05, 'voltage drop');
  // loss = 3*I^2*R
  approxEqual(calc.edgeLossesW.VOD01, 488.3, 1, 'losses');
  approxEqual(calc.edgeLoadingPct.VOD01, 18.042, 0.05, 'loading pct (max=100A)');
  approxEqual(calc.nodeVoltages.N01, 100 - (12.497 / 400) * 100, 0.05, 'node voltage pct');
});

test('two lines in series: voltage drop accumulates down the path', () => {
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'load' },
      { id: 'N02', x: 2, y: 0, kind: 'load' }
    ],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.3), makeEdge('VOD02', 'N01', 'N02', 0.3)],
    loads: [makeLoad('L01', 'N01', 4000, 0.9), makeLoad('L02', 'N02', 4000, 0.9)]
  };
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.equal(calc.valid, true);

  const dropAtN01 = calc.edgeDeltaUV.VOD01;
  const dropAtN02Edge = calc.edgeDeltaUV.VOD02;
  const expectedN02Pct = 100 - ((dropAtN01 + dropAtN02Edge) / 400) * 100;
  approxEqual(calc.nodeVoltages.N02, expectedN02Pct, 0.01, 'cumulative drop at deep node');
  assert.ok(calc.nodeVoltages.N02 < calc.nodeVoltages.N01, 'deeper node must have lower voltage');
});

test('branching: shared trunk edge carries combined current of both branches, not the sum of individual currents', () => {
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'junction' },
      { id: 'N02', x: 2, y: 0, kind: 'load' },
      { id: 'N03', x: 2, y: 1, kind: 'load' }
    ],
    edges: [
      makeEdge('VOD01', 'TS-01', 'N01', 0.1),
      makeEdge('VOD02', 'N01', 'N02', 0.1),
      makeEdge('VOD03', 'N01', 'N03', 0.1)
    ],
    loads: [makeLoad('L02', 'N02', 5000, 0.9), makeLoad('L03', 'N03', 5000, 0.9)]
  };
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.equal(calc.valid, true);

  // Combined S = sqrt((5000+5000)^2 + (Q1+Q2)^2), NOT I(VOD02)+I(VOD03) added naively
  // (they happen to be equal here so summing currents would coincidentally
  // look right for magnitude — check against the true aggregate formula instead).
  const q = 5000 * Math.tan(Math.acos(0.9));
  const expectedTrunkS = Math.sqrt((10000) ** 2 + (2 * q) ** 2);
  const expectedTrunkI = expectedTrunkS / (Math.sqrt(3) * 400);
  approxEqual(calc.edgeCurrents.VOD01, expectedTrunkI, 0.02, 'trunk current');
  approxEqual(calc.edgeCurrents.VOD01, calc.edgeCurrents.VOD02 + calc.edgeCurrents.VOD03, 0.02,
    'symmetric branch special case: sum happens to match here, sanity check only');
});

test('disconnecting a load reduces upstream current and can clear an overload alarm', () => {
  const cable = { id: 'weak', resistanceOhmPerKm: 1, maxCurrentA: 20 };
  const cablesLocal = { weak: cable };
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'load' }],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.2, { cableTypeId: 'weak' })],
    loads: [makeLoad('L01', 'N01', 15000, 0.9)]
  };
  const before = computeLoadFlow(network, cablesLocal, LIMITS);
  assert.ok(before.edgeLoadingPct.VOD01 > 100, 'sanity: should be overloaded before disconnect');
  assert.ok(before.alarms.some((a) => a.type === 'cable-overload' && a.severity === 'critical'));

  network.loads[0].connected = false;
  const after = computeLoadFlow(network, cablesLocal, LIMITS);
  assert.equal(after.edgeCurrents.VOD01, 0);
  assert.equal(after.alarms.some((a) => a.type === 'cable-overload'), false);
});

test('compensation reduces reactive power without changing active power', () => {
  const load = makeLoad('L01', 'N01', 10000, 0.6);
  const before = effectiveCosPhi(load);
  const qBefore = 10000 * Math.tan(Math.acos(before));

  load.compensationSteps = 1;
  const after = effectiveCosPhi(load);
  const qAfter = 10000 * Math.tan(Math.acos(after));

  assert.ok(after > before, 'compensation should raise effective cosPhi');
  assert.ok(qAfter < qBefore, 'reactive power must drop');
  // Active power is simply load.pW and is never touched by compensation.
  assert.equal(load.pW, 10000);
});

test('overloaded transformer produces a critical transformer-overload alarm', () => {
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 5, upgraded: false }, // deliberately tiny
    nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'load' }],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.1)],
    loads: [makeLoad('L01', 'N01', 10000, 0.9)]
  };
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.ok(calc.transformerLoadingPct > 100);
  assert.ok(calc.alarms.some((a) => a.type === 'transformer-overload' && a.severity === 'critical'));
});

test('cosPhi edge cases never produce NaN/Infinity', () => {
  const cases = [1, 0.02, 1.5, -0.3, 0];
  for (const cosPhi of cases) {
    const network = {
      transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
      nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'load' }],
      edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.2)],
      loads: [makeLoad('L01', 'N01', 5000, cosPhi)]
    };
    const calc = computeLoadFlow(network, cablesById, LIMITS);
    assert.equal(calc.valid, true, `cosPhi=${cosPhi}`);
    assert.ok(Number.isFinite(calc.edgeCurrents.VOD01), `current finite for cosPhi=${cosPhi}`);
    assert.ok(Number.isFinite(calc.nodeVoltages.N01), `voltage finite for cosPhi=${cosPhi}`);
    if (cosPhi > 1 || cosPhi <= 0) {
      assert.ok(calc.alarms.some((a) => a.type === 'data-error'), `should flag data-error for cosPhi=${cosPhi}`);
    }
  }
});

test('zero-length edge and very long edge both stay finite, no crash', () => {
  const zeroLenNetwork = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'load' }],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0)],
    loads: [makeLoad('L01', 'N01', 5000, 0.9)]
  };
  const zeroCalc = computeLoadFlow(zeroLenNetwork, cablesById, LIMITS);
  assert.equal(zeroCalc.edgeDeltaUV.VOD01, 0);
  assert.equal(zeroCalc.edgeLossesW.VOD01, 0);

  const longNetwork = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'load' }],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 500)], // absurdly long on purpose
    loads: [makeLoad('L01', 'N01', 5000, 0.9)]
  };
  const longCalc = computeLoadFlow(longNetwork, cablesById, LIMITS);
  assert.ok(Number.isFinite(longCalc.nodeVoltages.N01));
  assert.ok(longCalc.alarms.some((a) => a.type === 'undervoltage' && a.severity === 'critical'));
});

test('empty feeder (no downstream load) draws zero current, no crash', () => {
  const network = {
    transformer: { id: 'TS-01', ratedPowerKVA: 250, upgraded: false },
    nodes: [{ id: 'TS-01', x: 0, y: 0, kind: 'source' }, { id: 'N01', x: 1, y: 0, kind: 'junction' }],
    edges: [makeEdge('VOD01', 'TS-01', 'N01', 0.3)],
    loads: []
  };
  const calc = computeLoadFlow(network, cablesById, LIMITS);
  assert.equal(calc.valid, true);
  assert.equal(calc.edgeCurrents.VOD01, 0);
  assert.equal(calc.edgeLoadingPct.VOD01, 0);
  assert.equal(calc.nodeVoltages.N01, 100);
});
