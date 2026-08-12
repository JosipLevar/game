// validation.js
// Anything that enters the app from outside its own engine calls —
// localStorage, an imported JSON file — is untrusted until it passes
// through here. Never trust shape, never trust range, never trust type.

import { buildTopology } from './engine/topology.js';
import { SCHEMA_VERSION } from './constants.js';

const MAX_STRING_LEN = 200;

/** Strip control characters and clamp length. Defense in depth — the
 * renderer already uses textContent exclusively, never innerHTML, so this
 * cannot by itself cause an XSS bypass; it just keeps garbage out of state. */
export function sanitizeString(value, maxLen = MAX_STRING_LEN) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, '');
  return stripped.slice(0, maxLen);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN;
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNonNegNumber(v) {
  return isFiniteNumber(v) && v >= 0;
}
function isBool(v) {
  return typeof v === 'boolean';
}

function validateNode(node, errors, idx) {
  const p = `nodes[${idx}]`;
  if (!node || typeof node !== 'object') { errors.push(`${p}: nije objekt`); return; }
  if (!isNonEmptyString(node.id)) errors.push(`${p}.id: nedostaje ili neispravan`);
  if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y)) errors.push(`${p}: x/y nisu brojevi`);
  if (!['source', 'load', 'junction'].includes(node.kind)) errors.push(`${p}.kind: nepoznata vrijednost`);
}

function validateEdge(edge, errors, idx) {
  const p = `edges[${idx}]`;
  if (!edge || typeof edge !== 'object') { errors.push(`${p}: nije objekt`); return; }
  if (!isNonEmptyString(edge.id)) errors.push(`${p}.id: nedostaje`);
  if (!isNonEmptyString(edge.fromNodeId) || !isNonEmptyString(edge.toNodeId)) errors.push(`${p}: from/to nedostaje`);
  if (!isNonEmptyString(edge.cableTypeId)) errors.push(`${p}.cableTypeId: nedostaje`);
  if (!isNonNegNumber(edge.lengthKm)) errors.push(`${p}.lengthKm: mora biti broj ≥ 0`);
  if (!isBool(edge.allowShorten)) errors.push(`${p}.allowShorten: mora biti boolean`);
}

function validateLoad(load, errors, idx) {
  const p = `loads[${idx}]`;
  if (!load || typeof load !== 'object') { errors.push(`${p}: nije objekt`); return; }
  if (!isNonEmptyString(load.id)) errors.push(`${p}.id: nedostaje`);
  if (!isNonEmptyString(load.nodeId)) errors.push(`${p}.nodeId: nedostaje`);
  if (!isNonEmptyString(load.name)) errors.push(`${p}.name: nedostaje`);
  if (!isNonNegNumber(load.pW)) errors.push(`${p}.pW: mora biti broj ≥ 0`);
  if (!isFiniteNumber(load.cosPhi) || load.cosPhi <= 0 || load.cosPhi > 1) errors.push(`${p}.cosPhi: mora biti u (0,1]`);
  if (!isBool(load.priority)) errors.push(`${p}.priority: mora biti boolean`);
  if (!isBool(load.connected)) errors.push(`${p}.connected: mora biti boolean`);
  if (!isFiniteNumber(load.compensationSteps) || load.compensationSteps < 0) errors.push(`${p}.compensationSteps: mora biti broj ≥ 0`);
}

/**
 * Validate a full gameState object (from localStorage or an imported
 * file). Returns { valid, errors }. Never throws.
 */
export function validateGameState(state) {
  const errors = [];

  if (!state || typeof state !== 'object') {
    return { valid: false, errors: ['Datoteka ne sadrži valjan JSON objekt.'] };
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Nepodržana verzija sheme: ${state.schemaVersion}`);
  }
  if (!isNonEmptyString(state.gameId)) errors.push('gameId nedostaje.');
  if (!isFiniteNumber(state.seed)) errors.push('seed nedostaje ili nije broj.');
  if (!['setup', 'active', 'won', 'lost', 'abandoned'].includes(state.status)) errors.push('status je neispravan.');
  if (!isNonNegNumber(state.budgetInitialCents)) errors.push('budgetInitialCents mora biti broj ≥ 0.');
  if (!isNonNegNumber(state.budgetRemainingCents) && state.budgetRemainingCents !== undefined) {
    // remaining is allowed to be checked elsewhere for overspend; must still be a finite number
    if (!isFiniteNumber(state.budgetRemainingCents)) errors.push('budgetRemainingCents mora biti broj.');
  }
  if (!Number.isInteger(state.actionsRemaining)) errors.push('actionsRemaining mora biti cijeli broj.');

  if (!state.network || typeof state.network !== 'object') {
    errors.push('network nedostaje.');
  } else {
    const net = state.network;
    if (!net.transformer || !isNonEmptyString(net.transformer.id)) errors.push('network.transformer.id nedostaje.');
    if (!net.transformer || !isNonNegNumber(net.transformer.ratedPowerKVA)) errors.push('network.transformer.ratedPowerKVA mora biti broj ≥ 0.');
    if (!Array.isArray(net.nodes) || net.nodes.length === 0) errors.push('network.nodes mora biti neprazan niz.');
    else net.nodes.forEach((n, i) => validateNode(n, errors, i));
    if (!Array.isArray(net.edges)) errors.push('network.edges mora biti niz.');
    else net.edges.forEach((e, i) => validateEdge(e, errors, i));
    if (!Array.isArray(net.loads)) errors.push('network.loads mora biti niz.');
    else net.loads.forEach((l, i) => validateLoad(l, errors, i));

    if (errors.length === 0) {
      const topo = buildTopology(net);
      if (!topo.valid) errors.push(`Mreža nije valjano stablo (${topo.reason}).`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Validate an imported/parsed round-history or high-score entry array shape. */
export function validateHistoryArray(value) {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => entry && typeof entry === 'object' && isNonEmptyString(entry.gameId));
}
