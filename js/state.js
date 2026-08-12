// state.js
import { SCHEMA_VERSION } from './constants.js';

function generateGameId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'game-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Build a fresh gameState from a generated scenario. This is the ONLY
 * shape gameState is allowed to take — see validation.js for the schema
 * this must satisfy on every save/load/import round-trip.
 */
export function createInitialGameState({ seed, difficultyId, budgetInitialCents, actionsAllowed, network, scenario, calculated, score }) {
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    gameId: generateGameId(),
    seed,
    status: 'active',
    difficulty: difficultyId,
    startedAt: nowIso,
    elapsedSeconds: 0,
    lastResumedAtMs: Date.now(),
    budgetInitialCents,
    budgetRemainingCents: budgetInitialCents,
    actionsAllowedTotal: actionsAllowed,
    actionsRemaining: actionsAllowed,
    network,
    scenario,
    actionHistory: [],
    calculated: { ...calculated, score: score ?? 0 },
    outcome: null // set to {result:'won'|'lost', finalScore, endedAt} when the round ends
  };
}

/** Minimal pub-sub store. UI subscribes; nothing computes electrical values itself. */
export class Store {
  constructor(initialState) {
    this._state = initialState;
    this._listeners = new Set();
  }
  getState() {
    return this._state;
  }
  setState(newState) {
    this._state = newState;
    this._notify();
  }
  /** fn receives the current state and must return a new state object (immutable update). */
  update(fn) {
    this._state = fn(this._state);
    this._notify();
    return this._state;
  }
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _notify() {
    for (const listener of this._listeners) listener(this._state);
  }
}

/**
 * Elapsed-time bookkeeping that is explicitly NOT tied to
 * requestAnimationFrame — a backgrounded tab can throttle or pause rAF,
 * but wall-clock timestamps keep working, so resuming after a tab switch
 * still reports accurate elapsed time.
 */
export function pauseElapsedTime(state) {
  if (state.status !== 'active') return state;
  const deltaSeconds = Math.max(0, (Date.now() - state.lastResumedAtMs) / 1000);
  return { ...state, elapsedSeconds: state.elapsedSeconds + deltaSeconds, lastResumedAtMs: null };
}

export function resumeElapsedTime(state) {
  if (state.status !== 'active') return state;
  return { ...state, lastResumedAtMs: Date.now() };
}

export function currentElapsedSeconds(state) {
  if (state.lastResumedAtMs == null) return state.elapsedSeconds;
  return state.elapsedSeconds + Math.max(0, (Date.now() - state.lastResumedAtMs) / 1000);
}
