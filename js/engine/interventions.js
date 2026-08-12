// engine/interventions.js
// Every intervention goes through the exact same pipeline:
//   validate -> clone -> mutate -> recalculate -> return
// The caller (action-panel.js for preview, app.js for commit) decides
// whether to keep the result. Nothing here ever touches gameState or the
// DOM, which is what makes it independently testable.

import { ACTION_TYPES, ACTION_COSTS, COMPENSATION_MAX_COSPHI, SHORTEN_LINE_FACTOR } from '../constants.js';
import { buildTopology, wouldCreateCycle, getFeederRootForNode } from './topology.js';
import { computeLoadFlow, effectiveCosPhi } from './load-flow.js';

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fail(errors) {
  return { valid: false, errors: Array.isArray(errors) ? errors : [errors] };
}

// ---------------------------------------------------------------------
// Individual handlers. Each returns either fail([...]) or
// { valid:true, costCents, mutate(network) } where mutate performs the
// in-place change on an already-cloned network.
// ---------------------------------------------------------------------

function handleReplaceCable(network, params, ctx) {
  const edge = network.edges.find((e) => e.id === params.edgeId);
  if (!edge) return fail('Vod nije pronađen.');
  if (edge.interventions?.cableReplaced) return fail('Ovaj vod je već zamijenjen ovom rundom.');
  const oldCable = ctx.cablesById[edge.cableTypeId];
  const newCable = ctx.cablesById[params.newCableTypeId];
  if (!newCable) return fail('Nepoznat tip kabela.');
  if (!oldCable) return fail('Trenutni kabel nema poznate podatke.');
  if (newCable.id === oldCable.id) return fail('Odabran je isti tip kabela.');

  const rawCost = Math.round(Math.abs(newCable.costPerKmCents - oldCable.costPerKmCents) * edge.lengthKm);
  const costCents = clamp(rawCost, ACTION_COSTS[ACTION_TYPES.REPLACE_CABLE].min, ACTION_COSTS[ACTION_TYPES.REPLACE_CABLE].max);

  return {
    valid: true,
    costCents,
    mutate(net) {
      const e = net.edges.find((x) => x.id === params.edgeId);
      e.cableTypeId = params.newCableTypeId;
      e.interventions = { ...(e.interventions || {}), cableReplaced: true };
    }
  };
}

function handleShortenLine(network, params) {
  const edge = network.edges.find((e) => e.id === params.edgeId);
  if (!edge) return fail('Vod nije pronađen.');
  if (!edge.allowShorten) return fail('Skraćivanje nije dostupno za ovaj vod u ovom scenariju.');
  if (edge.interventions?.shortened) return fail('Ovaj vod je već skraćen ovom rundom.');

  return {
    valid: true,
    costCents: ACTION_COSTS[ACTION_TYPES.SHORTEN_LINE].flat,
    mutate(net) {
      const e = net.edges.find((x) => x.id === params.edgeId);
      e.lengthKm = Math.max(0.01, e.lengthKm * (1 - SHORTEN_LINE_FACTOR));
      e.interventions = { ...(e.interventions || {}), shortened: true };
    }
  };
}

function handleTransferLoad(network, params, ctx) {
  const movingNodeId = params.nodeId;
  const targetNodeId = params.targetParentNodeId;
  const movingNode = network.nodes.find((n) => n.id === movingNodeId);
  const targetNode = network.nodes.find((n) => n.id === targetNodeId);
  if (!movingNode) return fail('Čvor nije pronađen.');
  if (!targetNode) return fail('Ciljni čvor nije pronađen.');

  const topo = ctx.topo;
  const currentParent = topo.parentOf.get(movingNodeId);
  if (currentParent === undefined) return fail('Ne može se premjestiti korijenski čvor (TS).');
  if (currentParent === targetNodeId) return fail('Potrošač je već na tom izvodu.');
  if (wouldCreateCycle(movingNodeId, targetNodeId, topo)) {
    return fail('Ta izmjena bi stvorila petlju u mreži — nije dopušteno.');
  }

  const oldEdgeId = topo.edgeToParent.get(movingNodeId);
  const oldEdge = network.edges.find((e) => e.id === oldEdgeId);
  if (!oldEdge) return fail('Postojeći vod do čvora nije pronađen.');

  return {
    valid: true,
    costCents: ACTION_COSTS[ACTION_TYPES.TRANSFER_LOAD].flat,
    mutate(net) {
      const edge = net.edges.find((e) => e.id === oldEdgeId);
      // Re-point the same physical edge at its new parent — it keeps its
      // cable type and length (we're re-routing existing infrastructure).
      const otherEnd = edge.fromNodeId === movingNodeId ? edge.toNodeId : edge.fromNodeId;
      edge.fromNodeId = targetNodeId;
      edge.toNodeId = movingNodeId;
      void otherEnd; // previous parent side is simply dropped from this edge
    }
  };
}

function handleDisconnectLoad(network, params) {
  const load = network.loads.find((l) => l.id === params.loadId);
  if (!load) return fail('Potrošač nije pronađen.');
  if (load.priority) return fail('Prioritetni potrošač se ne smije isključiti.');
  if (!load.connected) return fail('Potrošač je već isključen.');

  return {
    valid: true,
    costCents: ACTION_COSTS[ACTION_TYPES.DISCONNECT_LOAD].flat,
    mutate(net) {
      const l = net.loads.find((x) => x.id === params.loadId);
      l.connected = false;
    }
  };
}

function handleAddCompensation(network, params) {
  const load = network.loads.find((l) => l.id === params.loadId);
  if (!load) return fail('Potrošač nije pronađen.');
  if (!load.connected) return fail('Isključeni potrošač ne može primiti kompenzaciju.');
  const current = effectiveCosPhi(load);
  if (current >= COMPENSATION_MAX_COSPHI - 1e-9) {
    return fail('Faktor snage je već na maksimalno dopuštenoj razini.');
  }

  return {
    valid: true,
    costCents: ACTION_COSTS[ACTION_TYPES.ADD_COMPENSATION].flat,
    mutate(net) {
      const l = net.loads.find((x) => x.id === params.loadId);
      l.compensationSteps = (l.compensationSteps || 0) + 1;
    }
  };
}

function handleUpgradeTransformer(network, params, ctx) {
  if (network.transformer.upgraded) return fail('Trafostanica je već pojačana ovom rundom.');
  const newSpec = ctx.transformersById[params.newTransformerId];
  if (!newSpec) return fail('Nepoznat tip trafostanice.');
  if (newSpec.ratedPowerKVA <= network.transformer.ratedPowerKVA) {
    return fail('Nova trafostanica mora biti jača od postojeće.');
  }

  return {
    valid: true,
    costCents: ACTION_COSTS[ACTION_TYPES.UPGRADE_TRANSFORMER].flat,
    mutate(net) {
      net.transformer.ratedPowerKVA = newSpec.ratedPowerKVA;
      net.transformer.upgraded = true;
    }
  };
}

const HANDLERS = {
  [ACTION_TYPES.REPLACE_CABLE]: handleReplaceCable,
  [ACTION_TYPES.SHORTEN_LINE]: handleShortenLine,
  [ACTION_TYPES.TRANSFER_LOAD]: handleTransferLoad,
  [ACTION_TYPES.DISCONNECT_LOAD]: handleDisconnectLoad,
  [ACTION_TYPES.ADD_COMPENSATION]: handleAddCompensation,
  [ACTION_TYPES.UPGRADE_TRANSFORMER]: handleUpgradeTransformer
};

/**
 * Run one intervention against a network. Used identically for preview
 * (discard the result) and commit (keep it). Never mutates the input.
 *
 * @returns {{valid:boolean, errors?:string[], costCents?:number,
 *            network?:object, calculated?:object}}
 */
export function simulateIntervention(network, actionType, params, ctx) {
  const handler = HANDLERS[actionType];
  if (!handler) return fail(`Nepoznata intervencija: ${actionType}`);

  const topo = buildTopology(network);
  if (!topo.valid) return fail('Postojeća mreža nije valjano stablo — proračun nije moguć.');

  const outcome = handler(network, params, { ...ctx, topo });
  if (!outcome.valid) return outcome;

  if (ctx.budgetRemainingCents !== undefined && outcome.costCents > ctx.budgetRemainingCents) {
    return fail('Nedovoljno budžeta za ovu intervenciju.');
  }
  if (ctx.actionsRemaining !== undefined && ctx.actionsRemaining <= 0) {
    return fail('Nema više raspoloživih intervencija.');
  }

  const clonedNetwork = deepClone(network);
  outcome.mutate(clonedNetwork);

  const newTopo = buildTopology(clonedNetwork);
  if (!newTopo.valid) {
    return fail('Ova intervencija bi pokvarila strukturu mreže (petlja ili odvojeni čvor).');
  }

  const calculated = computeLoadFlow(clonedNetwork, ctx.cablesById, ctx.limits);
  if (!calculated.valid) {
    return fail('Proračun nakon intervencije nije uspio — mreža nije valjana.');
  }

  return {
    valid: true,
    costCents: outcome.costCents,
    network: clonedNetwork,
    calculated
  };
}
