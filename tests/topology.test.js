import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopology, getPathEdgesToRoot, getSubtreeNodeIds,
  getDownstreamLoads, wouldCreateCycle
} from '../js/engine/topology.js';

function simpleChainNetwork() {
  return {
    transformer: { id: 'TS-01', ratedPowerKVA: 250 },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'load' },
      { id: 'N02', x: 2, y: 0, kind: 'load' }
    ],
    edges: [
      { id: 'VOD01', fromNodeId: 'TS-01', toNodeId: 'N01', cableTypeId: 'x', lengthKm: 0.1, allowShorten: false, interventions: {} },
      { id: 'VOD02', fromNodeId: 'N01', toNodeId: 'N02', cableTypeId: 'x', lengthKm: 0.1, allowShorten: false, interventions: {} }
    ],
    loads: [
      { id: 'L01', nodeId: 'N01', name: 'A', pW: 1000, cosPhi: 0.9, priority: false, connected: true, compensationSteps: 0 },
      { id: 'L02', nodeId: 'N02', name: 'B', pW: 2000, cosPhi: 0.9, priority: false, connected: true, compensationSteps: 0 }
    ]
  };
}

function branchingNetwork() {
  // TS -> N01 -> N02 (leaf)
  //          \-> N03 (leaf)
  return {
    transformer: { id: 'TS-01', ratedPowerKVA: 250 },
    nodes: [
      { id: 'TS-01', x: 0, y: 0, kind: 'source' },
      { id: 'N01', x: 1, y: 0, kind: 'junction' },
      { id: 'N02', x: 2, y: 0, kind: 'load' },
      { id: 'N03', x: 2, y: 1, kind: 'load' }
    ],
    edges: [
      { id: 'VOD01', fromNodeId: 'TS-01', toNodeId: 'N01', cableTypeId: 'x', lengthKm: 0.1, allowShorten: false, interventions: {} },
      { id: 'VOD02', fromNodeId: 'N01', toNodeId: 'N02', cableTypeId: 'x', lengthKm: 0.1, allowShorten: false, interventions: {} },
      { id: 'VOD03', fromNodeId: 'N01', toNodeId: 'N03', cableTypeId: 'x', lengthKm: 0.1, allowShorten: false, interventions: {} }
    ],
    loads: [
      { id: 'L02', nodeId: 'N02', name: 'A', pW: 1000, cosPhi: 0.9, priority: false, connected: true, compensationSteps: 0 },
      { id: 'L03', nodeId: 'N03', name: 'B', pW: 2000, cosPhi: 0.9, priority: false, connected: true, compensationSteps: 0 }
    ]
  };
}

test('buildTopology: valid chain resolves parent/child correctly', () => {
  const topo = buildTopology(simpleChainNetwork());
  assert.equal(topo.valid, true);
  assert.equal(topo.parentOf.get('N01'), 'TS-01');
  assert.equal(topo.parentOf.get('N02'), 'N01');
  assert.equal(topo.edgeToChild.get('VOD01'), 'N01');
});

test('buildTopology: detects disconnected node', () => {
  const net = simpleChainNetwork();
  net.nodes.push({ id: 'N99', x: 9, y: 9, kind: 'load' }); // no edge to it
  const topo = buildTopology(net);
  assert.equal(topo.valid, false);
});

test('buildTopology: detects a cycle (extra edge beyond N-1)', () => {
  const net = simpleChainNetwork();
  net.edges.push({ id: 'VOD-EXTRA', fromNodeId: 'TS-01', toNodeId: 'N02', cableTypeId: 'x', lengthKm: 0.05, allowShorten: false, interventions: {} });
  const topo = buildTopology(net);
  assert.equal(topo.valid, false);
  assert.equal(topo.reason, 'cycle-or-orphan-edge');
});

test('getPathEdgesToRoot: two edges in series accumulate for the deep node', () => {
  const net = simpleChainNetwork();
  const topo = buildTopology(net);
  const path = getPathEdgesToRoot('N02', topo);
  assert.deepEqual(path, ['VOD02', 'VOD01']);
});

test('branching: shared edge subtree includes both branch loads, exclusive edges include only their own', () => {
  const net = branchingNetwork();
  const topo = buildTopology(net);
  assert.equal(topo.valid, true);

  const sharedDownstream = getDownstreamLoads('VOD01', net, topo);
  assert.equal(sharedDownstream.length, 2, 'shared trunk edge must see both downstream loads');

  const branchADownstream = getDownstreamLoads('VOD02', net, topo);
  assert.equal(branchADownstream.length, 1);
  assert.equal(branchADownstream[0].id, 'L02');

  const branchBDownstream = getDownstreamLoads('VOD03', net, topo);
  assert.equal(branchBDownstream.length, 1);
  assert.equal(branchBDownstream[0].id, 'L03');
});

test('getSubtreeNodeIds: subtree of a branch point includes both children', () => {
  const net = branchingNetwork();
  const topo = buildTopology(net);
  const subtree = getSubtreeNodeIds('N01', topo);
  assert.deepEqual(new Set(subtree), new Set(['N01', 'N02', 'N03']));
});

test('wouldCreateCycle: moving a node under its own descendant is rejected', () => {
  const net = branchingNetwork();
  const topo = buildTopology(net);
  assert.equal(wouldCreateCycle('N01', 'N02', topo), true, 'N01 cannot move under its own child N02');
  assert.equal(wouldCreateCycle('N02', 'N03', topo), false, 'N02 -> N03 is a legitimate cross-feeder move');
});
