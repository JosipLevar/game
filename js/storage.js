// storage.js
import { STORAGE_KEYS, MAX_HISTORY_ENTRIES, MAX_HIGHSCORE_ENTRIES } from './constants.js';
import { validateGameState, validateHistoryArray } from './validation.js';

function safeGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : raw;
  } catch (err) {
    console.error('storage: read failed', key, err);
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error('storage: write failed', key, err);
    return false;
  }
}

function safeParse(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('storage: corrupted JSON, ignoring', err);
    return fallback;
  }
}

// --- Active game -------------------------------------------------------

export function saveActiveGame(state) {
  return safeSet(STORAGE_KEYS.activeGame, JSON.stringify(state));
}

/** Returns { found:false } | { found:true, valid, state, errors }. */
export function loadActiveGame() {
  const raw = safeGet(STORAGE_KEYS.activeGame);
  if (raw == null) return { found: false };
  const parsed = safeParse(raw, null);
  if (parsed == null) return { found: true, valid: false, errors: ['Spremljena runda je oštećena (neispravan JSON).'] };
  const { valid, errors } = validateGameState(parsed);
  return { found: true, valid, state: valid ? parsed : null, errors };
}

export function clearActiveGame() {
  try {
    localStorage.removeItem(STORAGE_KEYS.activeGame);
  } catch (err) {
    console.error('storage: clear failed', err);
  }
}

// --- History -------------------------------------------------------------

export function getHistory() {
  const raw = safeGet(STORAGE_KEYS.history);
  const parsed = safeParse(raw, []);
  return validateHistoryArray(parsed) ? parsed : [];
}

export function appendHistory(entry) {
  const history = getHistory();
  history.unshift(entry);
  const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);
  safeSet(STORAGE_KEYS.history, JSON.stringify(trimmed));
  return trimmed;
}

// --- High scores -----------------------------------------------------------

export function getHighScores() {
  const raw = safeGet(STORAGE_KEYS.highScores);
  const parsed = safeParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function submitHighScore(entry) {
  const scores = getHighScores();
  scores.push(entry);
  scores.sort((a, b) => (b.score || 0) - (a.score || 0));
  const trimmed = scores.slice(0, MAX_HIGHSCORE_ENTRIES);
  safeSet(STORAGE_KEYS.highScores, JSON.stringify(trimmed));
  return trimmed;
}

// --- Settings --------------------------------------------------------------

export function getSettings() {
  const raw = safeGet(STORAGE_KEYS.settings);
  return safeParse(raw, { theme: 'dark', lastDifficulty: 'operator' });
}

export function saveSettings(settings) {
  return safeSet(STORAGE_KEYS.settings, JSON.stringify(settings));
}

// --- Export / import ---------------------------------------------------

export function exportGameToJsonString(state) {
  return JSON.stringify(state, null, 2);
}

/** Parses + validates untrusted JSON text. Never mutates existing storage on failure. */
export function parseImportedGameJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: ['Datoteka nije valjan JSON.'] };
  }
  const { valid, errors } = validateGameState(parsed);
  return { valid, state: valid ? parsed : null, errors };
}

// --- Full reset ----------------------------------------------------------

export function resetAllLocalData() {
  try {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
    return true;
  } catch (err) {
    console.error('storage: reset failed', err);
    return false;
  }
}
