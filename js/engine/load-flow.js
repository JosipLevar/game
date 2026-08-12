// engine/load-flow.js
// Simplified balanced three-phase load flow for a radial LV network.
// Formulas straight from the spec:
//   Q = P * tan(acos(cosφ))
//   S = sqrt(P^2 + Q^2)
//   I = S / (sqrt(3) * U)
//   ΔU = sqrt(3) * I * (R*cosφ + X*sinφ)      [X = 0 in MVP]
//   R = Rkm * Lkm
//   P_loss = 3 * I^2 * R
//
// This module never mutates its inputs and never throws on bad data —
// bad data becomes a 'data-error' critical alarm instead, because a
// silent NaN reaching the UI is worse than a visible, explained failure.

import { buildTopology, getPathEdgesToRoot, getDownstreamLoads } from './topology.js';
import { COMPENSATION_MAX_COSPHI, COMPENSATION_STEP } from '../constants.js';

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Safe division: returns fallback instead of Infinity/NaN. */
function safeDiv(numerator, denominator, fallback = 0) {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator) || denominator === 0) {
    return fallback;
  }
  const result = numerator / denominator;
  return isFiniteNumber(result) ? result : fallback;
}

/**
 * Effective cosφ for a load after compensation steps, clamped to the
 * configured cap. Exported so the UI preview and interventions engine
 * show identical numbers to what load-flow will actually compute.
 */
export function effectiveCosPhi(load) {
  const base = isFiniteNumber(load.cosPhi) ? load.cosPhi : 1;
  const steps = isFiniteNumber(load.compensationSteps) ? load.compensationSteps : 0;
  const boosted = base + steps * COMPENSATION_STEP;
  return Math.min(COMPENSATION_MAX_COSPHI, Math.max(0.01, boosted));
}

/** P (W) and Q (var) contributed by a single load right now. */
function loadPQ(load) {
  if (!load.connected) return { p: 0, q: 0, dataError: false };
  const p = isFiniteNumber(load.pW) && load.pW >= 0 ? load.pW : 0;

  // Validity must be checked against the RAW input cosφ, not the
  // compensation-adjusted one — effectiveCosPhi() clamps its output into
  // a safe range for computation, which would otherwise silently hide a
  // genuinely invalid base cosφ (e.g. > 1) from the data-error alarm.
  const rawCosPhi = load.cosPhi;
  const rawValid = isFiniteNumber(rawCosPhi) && rawCosPhi > 0 && rawCosPhi <= 1;

  const cosPhi = effectiveCosPhi(load); // safe, clamped — used for the actual math either way
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const q = p * safeDiv(sinPhi, cosPhi, 0);

  return { p, q, dataError: !rawValid };
}

/**
 * Run the full load flow over a network. Returns a `calculated` object
 * shaped for direct assignment into gameState.calculated, or
 * { valid:false, reason } if the topology itself is broken.
 */
export function computeLoadFlow(network, cablesById, limits) {
  const topo = buildTopology(network);
  if (!topo.valid) {
    return { valid: false, reason: topo.reason };
  }

  const U = isFiniteNumber(limits.nominalVoltageV) && limits.nominalVoltageV > 0
    ? limits.nominalVoltageV
    : 400;
  const sqrt3 = Math.sqrt(3);

  const loadPowers = {}; // loadId -> {p,q}
  let dataErrorFound = false;
  for (const load of network.loads) {
    const { p, q, dataError } = loadPQ(load);
    loadPowers[load.id] = { p, q };
    if (dataError) dataErrorFound = true;
  }

  const edgeCurrents = {};
  const edgeLoadingPct = {};
  const edgeLossesW = {};
  const edgeDeltaUV = {};
  const edgeApparentPowerVA = {};
  const alarms = [];

  for (const edge of network.edges) {
    const downstreamLoads = getDownstreamLoads(edge.id, network, topo);
    let sumP = 0;
    let sumQ = 0;
    for (const load of downstreamLoads) {
      const pq = loadPowers[load.id];
      sumP += pq.p;
      sumQ += pq.q;
    }
    const S = Math.sqrt(sumP * sumP + sumQ * sumQ);
    const I = safeDiv(S, sqrt3 * U, 0);

    const cable = cablesById[edge.cableTypeId];
    let R = 0;
    let maxCurrentA = 0;
    if (cable && isFiniteNumber(cable.resistanceOhmPerKm) && isFiniteNumber(edge.lengthKm) && edge.lengthKm >= 0) {
      R = cable.resistanceOhmPerKm * edge.lengthKm;
      maxCurrentA = cable.maxCurrentA;
    } else {
      dataErrorFound = true;
    }

    const cosPhiAgg = S > 0 ? safeDiv(sumP, S, 1) : 1;
    const sinPhiAgg = S > 0 ? safeDiv(sumQ, S, 0) : 0;
    // X = 0 for MVP — reactance intentionally not modelled (see UI notice).
    const deltaU = sqrt3 * I * (R * cosPhiAgg + 0 * sinPhiAgg);
    const lossW = 3 * I * I * R;
    const loadingPct = maxCurrentA > 0 ? safeDiv(I, maxCurrentA, 0) * 100 : 999;

    edgeCurrents[edge.id] = I;
    edgeLoadingPct[edge.id] = loadingPct;
    edgeLossesW[edge.id] = lossW;
    edgeDeltaUV[edge.id] = deltaU;
    edgeApparentPowerVA[edge.id] = S;

    if (loadingPct >= limits.maxCableLoadingPct) {
      alarms.push({ severity: 'critical', type: 'cable-overload', targetType: 'edge', targetId: edge.id,
        message: `Vod ${edge.id}: opterećenje ${loadingPct.toFixed(0)}%` });
    } else if (loadingPct >= limits.warningCableLoadingPct) {
      alarms.push({ severity: 'warning', type: 'cable-overload', targetType: 'edge', targetId: edge.id,
        message: `Vod ${edge.id}: opterećenje ${loadingPct.toFixed(0)}%` });
    }
  }

  // Node voltages: cumulative ΔU along the path from each node to the root.
  const nodeVoltagesPct = {};
  const nodeVoltagesV = {};
  for (const node of network.nodes) {
    const pathEdges = getPathEdgesToRoot(node.id, topo);
    let totalDrop = 0;
    for (const edgeId of pathEdges) totalDrop += edgeDeltaUV[edgeId] || 0;
    const voltageV = U - totalDrop;
    const voltagePct = safeDiv(voltageV, U, 0) * 100;
    nodeVoltagesV[node.id] = voltageV;
    nodeVoltagesPct[node.id] = voltagePct;

    if (voltagePct < limits.minVoltagePct) {
      alarms.push({ severity: 'critical', type: 'undervoltage', targetType: 'node', targetId: node.id,
        message: `Čvor ${node.id}: napon ${voltagePct.toFixed(1)}%` });
    } else if (voltagePct < limits.warningVoltagePct) {
      alarms.push({ severity: 'warning', type: 'undervoltage', targetType: 'node', targetId: node.id,
        message: `Čvor ${node.id}: napon ${voltagePct.toFixed(1)}%` });
    }
  }

  // Transformer loading = total apparent power of every connected load.
  let totalP = 0;
  let totalQ = 0;
  for (const load of network.loads) {
    const pq = loadPowers[load.id];
    totalP += pq.p;
    totalQ += pq.q;
  }
  const totalS = Math.sqrt(totalP * totalP + totalQ * totalQ);
  const ratedVA = isFiniteNumber(network.transformer.ratedPowerKVA) && network.transformer.ratedPowerKVA > 0
    ? network.transformer.ratedPowerKVA * 1000
    : 0;
  const transformerLoadingPct = ratedVA > 0 ? safeDiv(totalS, ratedVA, 0) * 100 : 999;

  if (transformerLoadingPct >= limits.maxTransformerLoadingPct) {
    alarms.push({ severity: 'critical', type: 'transformer-overload', targetType: 'transformer',
      targetId: network.transformer.id, message: `TS ${network.transformer.id}: opterećenje ${transformerLoadingPct.toFixed(0)}%` });
  } else if (transformerLoadingPct >= limits.warningTransformerLoadingPct) {
    alarms.push({ severity: 'warning', type: 'transformer-overload', targetType: 'transformer',
      targetId: network.transformer.id, message: `TS ${network.transformer.id}: opterećenje ${transformerLoadingPct.toFixed(0)}%` });
  }

  // Disconnected priority loads (defensive — should be prevented upstream).
  for (const load of network.loads) {
    if (load.priority && !load.connected) {
      alarms.push({ severity: 'critical', type: 'priority-load-disconnected', targetType: 'load', targetId: load.id,
        message: `${load.name}: prioritetni potrošač nije napajan` });
    }
  }

  if (dataErrorFound) {
    alarms.push({ severity: 'critical', type: 'data-error', targetType: 'network', targetId: network.transformer.id,
      message: 'Neispravni ulazni podaci u proračunu — provjerite mrežu.' });
  }

  return {
    valid: true,
    nodeVoltages: nodeVoltagesPct,
    nodeVoltagesV,
    edgeCurrents,
    edgeLoadingPct,
    edgeLossesW,
    edgeDeltaUV,
    edgeApparentPowerVA,
    transformerLoadingPct,
    transformerApparentPowerVA: totalS,
    alarms
  };
}
