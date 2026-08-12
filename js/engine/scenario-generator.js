// engine/scenario-generator.js
// Turns a 32-bit seed + difficulty into a complete, reproducible round:
// topology, cables, consumers, budget, and 1-3 injected faults. Every
// injected fault is verified against the REAL load-flow engine before
// being returned — no fault is claimed unless it actually alarms.

// NOTE: scenario metadata (problem archetypes, consumer name pool) is
// passed in as `scenarioMeta` rather than imported here, so this module
// has no JSON-import-assertion dependency and stays trivially portable
// and Node-testable across engine versions.
import { createRng, rngInt, rngFloat, rngPick, rngShuffle } from '../rng.js';
import { DIFFICULTY, LIMITS } from '../constants.js';
import { buildTopology } from './topology.js';
import { computeLoadFlow } from './load-flow.js';

const sqrt3 = Math.sqrt(3);

function buildFeederChainWithOptionalBranch(rng, rootParentId, nodeTarget, feederIdx, ids, xBase, yBase) {
  const nodes = [];
  const edges = [];
  let prevId = rootParentId;
  let x = xBase;
  const branchAllowed = nodeTarget >= 4 && rng() < 0.4;
  const branchAtIndex = branchAllowed ? rngInt(rng, 1, nodeTarget - 2) : -1;
  let branchParentId = null;

  for (let i = 0; i < nodeTarget; i++) {
    const nodeId = ids.nextNodeId();
    x += 130;
    const y = yBase + (i === branchAtIndex + 1 && branchAllowed ? 70 : 0);
    nodes.push({ id: nodeId, x, y, kind: 'load' });
    const edgeId = ids.nextEdgeId();
    edges.push({
      id: edgeId,
      fromNodeId: prevId,
      toNodeId: nodeId,
      cableTypeId: null, // filled in by caller
      lengthKm: null,    // filled in by caller
      allowShorten: false,
      interventions: { cableReplaced: false, shortened: false }
    });
    if (i === branchAtIndex) branchParentId = prevId;
    prevId = nodeId;
  }

  // Optional second branch off an earlier node in this feeder, so some
  // edges genuinely carry the sum of two downstream sub-branches.
  if (branchAllowed && branchParentId) {
    const branchNodeId = ids.nextNodeId();
    nodes.push({ id: branchNodeId, x: xBase + (branchAtIndex + 1) * 130, y: yBase - 70, kind: 'load' });
    const branchEdgeId = ids.nextEdgeId();
    edges.push({
      id: branchEdgeId,
      fromNodeId: branchParentId,
      toNodeId: branchNodeId,
      cableTypeId: null,
      lengthKm: null,
      allowShorten: false,
      interventions: { cableReplaced: false, shortened: false }
    });
  }

  return { nodes, edges };
}

function pickConsumerNames(rng, count, scenarioMeta) {
  const pool = rngShuffle(rng, scenarioMeta.consumerNamePool);
  const names = [];
  for (let i = 0; i < count; i++) {
    const base = pool[i % pool.length];
    const suffix = i >= pool.length ? ` ${Math.floor(i / pool.length) + 1}` : '';
    names.push(base + suffix);
  }
  return names;
}

const INHERENTLY_PRIORITY_NAMES = new Set([
  'Ambulanta', 'Vrtić Zvončić', 'OŠ Bregana', 'Staračka kuća', 'Crpna stanica'
]);

function makeIdFactory() {
  let nodeN = 0;
  let edgeN = 0;
  let loadN = 0;
  return {
    nextNodeId: () => `N${String(++nodeN).padStart(2, '0')}`,
    nextEdgeId: () => `VOD${String(++edgeN).padStart(2, '0')}`,
    nextLoadId: () => `L${String(++loadN).padStart(2, '0')}`
  };
}

function isLeafEdge(edge, network) {
  // An edge is a "leaf edge" if its child node has no children of its own.
  const childId = edge.toNodeId;
  return !network.edges.some((e) => e.fromNodeId === childId);
}

/**
 * Solve P (W) for a load so that, in isolation on a leaf edge, it produces
 * a target line-loading fraction (e.g. 1.15 = 115%) at the given cosPhi.
 */
function solvePowerForLoadingFraction(maxCurrentA, loadingFraction, cosPhi) {
  const targetI = maxCurrentA * loadingFraction;
  const targetS = targetI * sqrt3 * LIMITS.nominalVoltageV;
  return Math.round(targetS * cosPhi);
}

export function generateScenario({ seed, difficultyId, cablesById, transformersById, scenarioMeta }) {
  const difficulty = DIFFICULTY[difficultyId] || DIFFICULTY.operator;
  const rng = createRng(seed >>> 0);
  const ids = makeIdFactory();

  const transformerBaseId = {
    beginner: () => 'ts-250',
    operator: () => rngPick(rng, ['ts-160', 'ts-250']),
    projektant: () => rngPick(rng, ['ts-100', 'ts-160'])
  }[difficulty.id]();

  const rootId = 'TS-01';
  const nodes = [{ id: rootId, x: 60, y: 260, kind: 'source' }];
  const edges = [];

  const feederCount = rngInt(rng, difficulty.feederCountRange[0], difficulty.feederCountRange[1]);
  const feederYPositions = [140, 260, 380].slice(0, feederCount);
  for (let f = 0; f < feederCount; f++) {
    const nodeTarget = rngInt(rng, difficulty.nodesPerFeederRange[0], difficulty.nodesPerFeederRange[1]);
    const { nodes: fNodes, edges: fEdges } = buildFeederChainWithOptionalBranch(
      rng, rootId, nodeTarget, f, ids, 60, feederYPositions[f]
    );
    nodes.push(...fNodes);
    edges.push(...fEdges);
  }

  // Baseline cable + length + consumer assignment (healthy-ish defaults).
  const midCableIds = ['nyy-4x25', 'nyy-4x35'];
  for (const edge of edges) {
    edge.cableTypeId = rngPick(rng, midCableIds);
    edge.lengthKm = Number(rngFloat(rng, 0.05, 0.30).toFixed(3));
  }

  const loadNodes = nodes.filter((n) => n.kind === 'load');
  const names = pickConsumerNames(rng, loadNodes.length, scenarioMeta);
  const loads = loadNodes.map((node, i) => {
    const name = names[i];
    const inherentPriority = INHERENTLY_PRIORITY_NAMES.has(name.replace(/ \d+$/, ''));
    const priority = inherentPriority || rng() < 0.2;
    return {
      id: ids.nextLoadId(),
      nodeId: node.id,
      name,
      pW: Math.round(rngFloat(rng, 3000, 13000)),
      cosPhi: Number(rngFloat(rng, 0.87, 0.97).toFixed(2)),
      priority,
      connected: true,
      compensationSteps: 0
    };
  });
  if (!loads.some((l) => l.priority)) loads[0].priority = true;

  const network = {
    transformer: {
      id: rootId,
      ratedPowerKVA: transformersById[transformerBaseId].ratedPowerKVA,
      upgraded: false
    },
    nodes,
    edges,
    loads
  };

  // --- Inject problems, each verified against the real engine. ---
  const problemCount = rngInt(rng, difficulty.problemCountRange[0], difficulty.problemCountRange[1]);
  // First pick a fair random SUBSET (this must include transformer-overload
  // with the same odds as anything else). Only the EXECUTION ORDER of that
  // subset is then fixed so 'transformer-overload' — which scales every
  // load's P to hit a target aggregate — always runs LAST. Otherwise a
  // later per-edge injection could overwrite a load's pW and silently
  // undo the transformer scaling that came before it.
  const chosenSubset = rngShuffle(rng, scenarioMeta.problemTypes).slice(0, problemCount);
  const problemTypesShuffled = chosenSubset
    .slice()
    .sort((a, b) => (a.id === 'transformer-overload') - (b.id === 'transformer-overload'));
  const leafEdgesShuffled = rngShuffle(rng, edges.filter((e) => isLeafEdge(e, network)));

  const events = [];
  let leafCursor = 0;

  function loadForEdge(edge) {
    const load = network.loads.find((l) => l.nodeId === edge.toNodeId);
    return load;
  }

  function alarmsOfType(type) {
    const calc = computeLoadFlow(network, cablesById, LIMITS);
    return calc.valid ? calc.alarms.filter((a) => a.type === type && a.severity !== undefined) : [];
  }

  for (let p = 0; p < problemCount && p < problemTypesShuffled.length; p++) {
    const problemType = problemTypesShuffled[p];

    if (problemType.id === 'voltage-drop' && leafCursor < leafEdgesShuffled.length) {
      const edge = leafEdgesShuffled[leafCursor++];
      edge.cableTypeId = 'nyy-4x16'; // weakest tier
      edge.allowShorten = true;
      edge.lengthKm = 0.7;
      const load = loadForEdge(edge);
      if (load) { load.pW = Math.round(rngFloat(rng, 9000, 14000)); load.cosPhi = 0.9; }

      for (let tries = 0; tries < 6; tries++) {
        const stillOk = alarmsOfType('undervoltage').every((a) => a.targetId !== edge.toNodeId);
        if (!stillOk) break;
        edge.lengthKm = Number((edge.lengthKm * 1.35).toFixed(3));
        if (load) load.pW = Math.round(load.pW * 1.15);
      }
      events.push({ id: `evt-${p}`, type: 'voltage-drop', title: problemType.title,
        description: problemType.description, targetType: 'node', targetId: edge.toNodeId });

    } else if (problemType.id === 'cable-overload' && leafCursor < leafEdgesShuffled.length) {
      const edge = leafEdgesShuffled[leafCursor++];
      edge.cableTypeId = 'nyy-4x16';
      const cable = cablesById[edge.cableTypeId];
      const load = loadForEdge(edge);
      if (load) {
        load.cosPhi = 0.92;
        load.pW = solvePowerForLoadingFraction(cable.maxCurrentA, 1.2, load.cosPhi);
      }
      for (let tries = 0; tries < 6; tries++) {
        const stillOk = alarmsOfType('cable-overload').every((a) => a.targetId !== edge.id);
        if (!stillOk) break;
        if (load) load.pW = Math.round(load.pW * 1.2);
      }
      events.push({ id: `evt-${p}`, type: 'cable-overload', title: problemType.title,
        description: problemType.description, targetType: 'edge', targetId: edge.id });

    } else if (problemType.id === 'poor-power-factor' && leafCursor < leafEdgesShuffled.length) {
      const edge = leafEdgesShuffled[leafCursor++];
      const cable = cablesById[edge.cableTypeId];
      const load = loadForEdge(edge);
      if (load) {
        load.cosPhi = 0.6;
        load.pW = solvePowerForLoadingFraction(cable.maxCurrentA, 0.92, load.cosPhi);
      }
      for (let tries = 0; tries < 6; tries++) {
        const loadingNow = computeLoadFlow(network, cablesById, LIMITS);
        const pct = loadingNow.valid ? loadingNow.edgeLoadingPct[edge.id] : 0;
        if (pct >= LIMITS.warningCableLoadingPct) break;
        if (load) load.pW = Math.round(load.pW * 1.15);
      }
      events.push({ id: `evt-${p}`, type: 'poor-power-factor', title: problemType.title,
        description: problemType.description, targetType: 'load', targetId: load ? load.id : null });

    } else if (problemType.id === 'transformer-overload') {
      const before = computeLoadFlow(network, cablesById, LIMITS);
      const currentS = before.valid ? before.transformerApparentPowerVA : 0;
      const ratedVA = network.transformer.ratedPowerKVA * 1000;
      const targetS = ratedVA * 1.1;
      if (currentS > 0 && targetS > currentS) {
        const factor = targetS / currentS;
        for (const load of network.loads) load.pW = Math.round(load.pW * factor);
      } else {
        for (const load of network.loads) load.pW = Math.round(load.pW * 1.6);
      }
      events.push({ id: `evt-${p}`, type: 'transformer-overload', title: problemType.title,
        description: problemType.description, targetType: 'transformer', targetId: network.transformer.id });
    }
  }

  const topoCheck = buildTopology(network);
  const finalCalc = computeLoadFlow(network, cablesById, LIMITS);

  const scenarioTitle = events.length > 0
    ? events.map((e) => e.title).join(' + ')
    : 'Redovna kontrola mreže';
  const scenarioDescription = events.length > 0
    ? events.map((e) => e.description).join(' ')
    : 'Nema aktivnih kvarova — provjerite stanje mreže i po potrebi optimizirajte.';

  return {
    valid: topoCheck.valid && finalCalc.valid,
    seed,
    difficulty: difficulty.id,
    budgetInitialCents: difficulty.budgetInitialCents,
    actionsAllowed: difficulty.actionsAllowed,
    network,
    scenario: {
      id: `seed-${seed}`,
      title: scenarioTitle,
      description: scenarioDescription,
      events
    },
    calculated: finalCalc
  };
}
