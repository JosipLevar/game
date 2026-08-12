// app.js — bootstraps GridFix and wires every module together.
// gameState (via Store) is the single source of truth; this file computes
// nothing electrical itself — it only calls the engine and re-renders.

import { LIMITS, DIFFICULTY, ACTION_LABELS } from './constants.js';
import { createInitialGameState, Store, pauseElapsedTime, resumeElapsedTime, currentElapsedSeconds } from './state.js';
import * as storage from './storage.js';
import { generateScenario } from './engine/scenario-generator.js';
import { simulateIntervention } from './engine/interventions.js';
import { computeScore, evaluateWinCondition, evaluateLossCondition } from './engine/scoring.js';
import { generateRandomSeed } from './rng.js';
import { renderNetworkSvg, renderLegend } from './ui/renderer-svg.js';
import { renderInspector } from './ui/inspector.js';
import { renderActionPanel } from './ui/action-panel.js';
import { confirmDialog, messageDialog, showRoundEndDialog } from './ui/dialogs.js';
import { showToast, showErrorToast } from './ui/notifications.js';

// ---------------------------------------------------------------------
// Global (module-scoped) runtime state. `store` holds the persisted
// gameState; `uiState` holds transient, non-persisted UI-only state
// (current selection, an in-progress action preview).
// ---------------------------------------------------------------------
let store = null;
let uiState = { selected: null, previewAction: null };
let cablesById = {};
let transformersById = {};
let scenarioMeta = null;
let elapsedTimerHandle = null;

const $ = (id) => document.getElementById(id);

function fmtEur(cents) {
  return `${Math.round(cents / 100).toLocaleString('hr-HR')} €`;
}
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Ne mogu učitati ${path} (${res.status})`);
  return res.json();
}

async function boot() {
  try {
    const [cablesArr, transformersArr, scenarioMetaLoaded] = await Promise.all([
      loadJson('js/data/cables.json'),
      loadJson('js/data/transformers.json'),
      loadJson('js/data/scenarios.json')
    ]);
    cablesById = Object.fromEntries(cablesArr.map((c) => [c.id, c]));
    transformersById = Object.fromEntries(transformersArr.map((t) => [t.id, t]));
    scenarioMeta = scenarioMetaLoaded;
  } catch (err) {
    console.error(err);
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'padding:2rem;font-family:monospace;color:#ff5a5a;';
    p.textContent = 'Neuspjelo učitavanje podataka igre (js/data/*.json). Ako otvarate index.html izravno dvoklikom, ' +
      'preglednik blokira module preko file:// protokola — pokrenite lokalni server, npr. "python3 -m http.server" ' +
      'u mapi projekta, pa otvorite http://localhost:8000, ili postavite na GitHub Pages.';
    document.body.appendChild(p);
    return;
  }

  wireStaticControls();
  applyTheme(storage.getSettings().theme || 'dark');
  refreshStartScreen();
  showScreen('start');

  window.addEventListener('beforeunload', () => {
    if (store && store.getState().status === 'active') {
      storage.saveActiveGame(pauseElapsedTime(store.getState()));
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!store) return;
    const state = store.getState();
    if (state.status !== 'active') return;
    if (document.hidden) {
      store.update(pauseElapsedTime);
      storage.saveActiveGame(store.getState());
    } else {
      store.update(resumeElapsedTime);
    }
  });
}

// ---------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------

function showScreen(which) {
  $('screen-start').classList.toggle('active', which === 'start');
  $('screen-game').classList.toggle('active', which === 'game');
  $('btn-home').hidden = which !== 'game';
}

function announce(msg) {
  const region = $('live-region');
  if (region) region.textContent = msg;
}

// ---------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------

function refreshStartScreen() {
  const activeLoad = storage.loadActiveGame();
  const continuePanel = $('panel-continue');
  if (activeLoad.found && activeLoad.valid && activeLoad.state.status === 'active') {
    continuePanel.hidden = false;
    const s = activeLoad.state;
    $('continue-summary').textContent =
      `${DIFFICULTY[s.difficulty]?.label || s.difficulty} · seed ${s.seed} · ${s.actionsRemaining} intervencija preostalo`;
  } else if (activeLoad.found && !activeLoad.valid) {
    continuePanel.hidden = false;
    $('continue-summary').textContent = 'Spremljena runda je oštećena i ne može se nastaviti.';
    const btn = $('btn-continue');
    btn.textContent = 'Ukloni oštećenu rundu';
    btn.onclick = () => { storage.clearActiveGame(); refreshStartScreen(); };
  } else {
    continuePanel.hidden = true;
  }

  renderHistoryList();
  renderHighScoreList();
}

function renderHistoryList() {
  const container = $('history-list');
  const history = storage.getHistory();
  container.replaceChildren();
  if (history.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Još nema odigranih rundi.';
    container.appendChild(p);
    return;
  }
  for (const entry of history.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const left = document.createElement('span');
    const resultWord = entry.result === 'won' ? '✓ Uspješno' : entry.result === 'lost' ? '✕ Neuspješno' : '– Odustao';
    left.textContent = `${resultWord} · ${DIFFICULTY[entry.difficulty]?.label || entry.difficulty}`;
    const right = document.createElement('span');
    right.className = 'lr-meta';
    right.textContent = `score ${entry.score} · seed ${entry.seed}`;
    row.append(left, right);
    container.appendChild(row);
  }
}

function renderHighScoreList() {
  const container = $('highscore-list');
  const scores = storage.getHighScores();
  container.replaceChildren();
  if (scores.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Još nema spremljenih rezultata.';
    container.appendChild(p);
    return;
  }
  scores.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    const left = document.createElement('span');
    left.textContent = `#${i + 1} — ${entry.score} bodova`;
    const right = document.createElement('span');
    right.className = 'lr-meta';
    right.textContent = `${DIFFICULTY[entry.difficulty]?.label || entry.difficulty} · seed ${entry.seed}`;
    row.append(left, right);
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------

function startNewGame(difficultyId) {
  const seed = generateRandomSeed();
  const gen = generateScenario({ seed, difficultyId, cablesById, transformersById, scenarioMeta });
  if (!gen.valid) {
    // Should not happen (scenario-generator self-verifies), but never leave
    // the player stuck without an explanation if it ever does.
    showErrorToast('Generiranje scenarija nije uspjelo. Pokušajte ponovno.');
    return;
  }
  const scoreNow = computeScore({
    network: gen.network, calculated: gen.calculated,
    budgetInitialCents: gen.budgetInitialCents, budgetRemainingCents: gen.budgetInitialCents, actionsUsed: 0
  });
  const initialState = createInitialGameState({ ...gen, score: scoreNow });

  store = new Store(initialState);
  uiState = { selected: null, previewAction: null };
  storage.saveActiveGame(initialState);
  showScreen('game');
  renderGameScreen();
  startElapsedTimer();
  announce(`Nova runda pokrenuta: ${gen.scenario.title}`);
}

function continueGame() {
  const loaded = storage.loadActiveGame();
  if (!loaded.found || !loaded.valid) {
    messageDialog({ title: 'Nije moguće nastaviti', body: 'Spremljena runda ne postoji ili je oštećena.' });
    return;
  }
  store = new Store(resumeElapsedTime(loaded.state));
  uiState = { selected: null, previewAction: null };
  showScreen('game');
  renderGameScreen();
  startElapsedTimer();
}

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimerHandle = setInterval(() => {
    if (!store) return;
    const state = store.getState();
    if (state.status !== 'active') return;
    const el = $('status-elapsed');
    if (el) el.textContent = fmtDuration(currentElapsedSeconds(state));
  }, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimerHandle) clearInterval(elapsedTimerHandle);
  elapsedTimerHandle = null;
}

async function giveUp() {
  const confirmed = await confirmDialog({
    title: 'Odustani od runde?',
    body: 'Runda će biti označena kao neuspješna i spremljena u povijest. Ova radnja se ne može poništiti.',
    confirmLabel: 'Odustani od runde',
    danger: true
  });
  if (!confirmed) return;

  const state = pauseElapsedTime(store.getState());
  const finished = { ...state, status: 'abandoned', outcome: { result: 'abandoned', finalScore: state.calculated.score, endedAt: new Date().toISOString() } };
  finishRound(finished, { showDialog: false });
  showScreen('start');
  refreshStartScreen();
}

function finishRound(finishedState, { showDialog }) {
  stopElapsedTimer();
  storage.appendHistory({
    gameId: finishedState.gameId,
    result: finishedState.outcome.result,
    score: finishedState.outcome.finalScore,
    difficulty: finishedState.difficulty,
    seed: finishedState.seed,
    elapsedSeconds: Math.round(currentElapsedSeconds(finishedState)),
    endedAt: finishedState.outcome.endedAt
  });
  if (finishedState.outcome.result === 'won') {
    storage.submitHighScore({
      gameId: finishedState.gameId, score: finishedState.outcome.finalScore,
      difficulty: finishedState.difficulty, seed: finishedState.seed
    });
  }
  storage.clearActiveGame();
  store.setState(finishedState);

  if (showDialog) {
    renderGameScreen();
    showRoundEndDialog({
      won: finishedState.outcome.result === 'won',
      score: finishedState.outcome.finalScore,
      seed: finishedState.seed,
      elapsedSeconds: currentElapsedSeconds(finishedState),
      budgetSpentCents: finishedState.budgetInitialCents - finishedState.budgetRemainingCents,
      actionsUsed: finishedState.actionsAllowedTotal - finishedState.actionsRemaining,
      reasons: finishedState.outcome.reasons || [],
      onPlayAgain: () => startNewGame(finishedState.difficulty),
      onGoHome: () => { showScreen('start'); refreshStartScreen(); }
    });
  }
}

function exportRound() {
  if (!store) return;
  const json = storage.exportGameToJsonString(store.getState());
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gridfix-${store.getState().seed}-${store.getState().gameId}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importRoundFromFile(file) {
  const text = await file.text();
  const result = storage.parseImportedGameJson(text);
  if (!result.valid) {
    await messageDialog({ title: 'Uvoz nije uspio', body: result.errors.join(' ') || 'Datoteka nije valjana runda.' });
    return;
  }
  // NOTE: only resumeElapsedTime here, deliberately not pauseElapsedTime first —
  // the imported file's lastResumedAtMs may be a stale timestamp from whenever
  // it was originally exported (hours/days ago). Calling pauseElapsedTime would
  // compute Date.now() - staleTimestamp and wrongly inflate elapsedSeconds by
  // that whole gap. resumeElapsedTime alone just re-bases the "clock start"
  // to now while keeping the already-accumulated elapsedSeconds as-is.
  store = new Store(resumeElapsedTime(result.state));
  uiState = { selected: null, previewAction: null };
  storage.saveActiveGame(store.getState());
  showScreen('game');
  renderGameScreen();
  if (result.state.status === 'active') startElapsedTimer();
  announce('Runda uvezena.');
}

// ---------------------------------------------------------------------
// Committing an intervention
// ---------------------------------------------------------------------

function buildDeltaToastLines(prevState, nextState) {
  const lines = [];
  const prevAlarms = prevState.calculated.alarms || [];
  const nextAlarms = nextState.calculated.alarms || [];
  const alarmKey = (a) => `${a.type}:${a.targetId}`;
  const nextKeys = new Set(nextAlarms.map(alarmKey));
  const prevKeys = new Set(prevAlarms.map(alarmKey));

  for (const a of prevAlarms) {
    if (!nextKeys.has(alarmKey(a))) {
      lines.push({ text: `✓ Otklonjeno: ${a.message}`, kind: 'plus' });
    }
  }
  for (const a of nextAlarms) {
    if (a.severity === 'critical' && !prevKeys.has(alarmKey(a))) {
      lines.push({ text: `⚠ Novo upozorenje: ${a.message}`, kind: 'minus' });
    }
  }
  lines.push({ text: `− Budžet: ${fmtEur(nextState.budgetRemainingCents)}`, kind: 'minus' });
  lines.push({ text: `− Preostale intervencije: ${nextState.actionsRemaining}`, kind: 'minus' });
  return lines;
}

function commitIntervention(actionType, params) {
  const prevState = store.getState();
  const ctx = {
    cablesById, transformersById, limits: LIMITS,
    budgetRemainingCents: prevState.budgetRemainingCents,
    actionsRemaining: prevState.actionsRemaining
  };
  const result = simulateIntervention(prevState.network, actionType, params, ctx);
  if (!result.valid) {
    // Defensive: budget/state could not realistically have changed between
    // preview and confirm since both run synchronously — but never silently
    // eat a failure.
    showErrorToast(result.errors.join(' '));
    uiState.previewAction = null;
    renderGameScreen();
    return;
  }

  const newBudgetRemaining = prevState.budgetRemainingCents - result.costCents;
  const newActionsRemaining = prevState.actionsRemaining - 1;
  const actionsUsed = prevState.actionsAllowedTotal - newActionsRemaining;
  const scoreNow = computeScore({
    network: result.network, calculated: result.calculated,
    budgetInitialCents: prevState.budgetInitialCents, budgetRemainingCents: newBudgetRemaining, actionsUsed
  });
  const historyEntry = {
    actionType, params, label: ACTION_LABELS[actionType],
    costCents: result.costCents, at: new Date().toISOString(), scoreAfter: scoreNow
  };

  let nextState = {
    ...prevState,
    network: result.network,
    calculated: { ...result.calculated, score: scoreNow },
    budgetRemainingCents: newBudgetRemaining,
    actionsRemaining: newActionsRemaining,
    actionHistory: [...prevState.actionHistory, historyEntry]
  };

  const winEval = evaluateWinCondition({
    network: nextState.network, calculated: nextState.calculated,
    budgetRemainingCents: nextState.budgetRemainingCents, actionsRemaining: nextState.actionsRemaining
  });

  let justFinished = false;
  if (winEval.won) {
    nextState = { ...nextState, status: 'won', outcome: { result: 'won', finalScore: scoreNow, endedAt: new Date().toISOString() } };
    justFinished = true;
  } else if (evaluateLossCondition({ winEvaluation: winEval, budgetRemainingCents: nextState.budgetRemainingCents, actionsRemaining: nextState.actionsRemaining })) {
    nextState = { ...nextState, status: 'lost', outcome: { result: 'lost', finalScore: scoreNow, endedAt: new Date().toISOString(), reasons: winEval.reasons } };
    justFinished = true;
  }

  const toastLines = buildDeltaToastLines(prevState, nextState);

  store.setState(nextState);
  storage.saveActiveGame(nextState); // "Automatsko spremanje nakon svake potvrđene akcije"
  uiState.previewAction = null;
  // Selection stays as-is: edge/node/transformer IDs are stable across
  // interventions (transfer-load re-points an edge but keeps its ID).

  showToast(toastLines);

  if (justFinished) {
    finishRound(nextState, { showDialog: true });
  } else {
    renderGameScreen();
  }
}

// ---------------------------------------------------------------------
// Rendering — everything is re-derived from (store state) + (uiState).
// Networks here are small (≤ ~20 nodes), so a full re-render on every
// change is simple, correct, and fast enough; no incremental diffing.
// ---------------------------------------------------------------------

function renderGameScreen() {
  if (!store) return;
  const state = store.getState();

  $('scenario-title').textContent = `${state.scenario.title} — ${DIFFICULTY[state.difficulty]?.label || state.difficulty}`;
  $('scenario-description').textContent = state.scenario.description;

  renderNetworkSvg($('network-svg-wrap'), {
    network: state.network, calculated: state.calculated, limits: LIMITS, cablesById,
    selected: uiState.selected,
    onSelect: (type, id) => { uiState.selected = { type, id }; uiState.previewAction = null; renderGameScreen(); }
  });
  renderLegend($('network-legend'));
  renderAlarmsTable(state);
  renderInspector($('inspector'), { selected: uiState.selected, network: state.network, calculated: state.calculated, cablesById, limits: LIMITS });
  renderActionPanel($('action-panel'), {
    selected: uiState.selected, previewAction: uiState.previewAction, gameState: state,
    cablesById, transformersById, limits: LIMITS,
    onPreviewStart: (actionType, params) => { uiState.previewAction = { actionType, params }; renderGameScreen(); },
    onPreviewCancel: () => { uiState.previewAction = null; renderGameScreen(); },
    onCommit: commitIntervention
  });
  renderActionLog(state);
  renderStatusBar(state);
  renderPrintSummary(state);
}

function renderAlarmsTable(state) {
  const container = $('alarms-table');
  container.replaceChildren();
  const alarms = state.calculated.alarms || [];
  if (alarms.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Nema aktivnih upozorenja.';
    container.appendChild(p);
    return;
  }
  const sorted = [...alarms].sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));
  for (const alarm of sorted) {
    const row = document.createElement('div');
    row.className = `alarm-row severity-${alarm.severity}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const icon = document.createElement('span');
    icon.className = 'alarm-icon';
    icon.textContent = '⚠';
    const msg = document.createElement('span');
    msg.textContent = `${alarm.severity === 'critical' ? 'KRITIČNO' : 'UPOZORENJE'} — ${alarm.message}`;
    row.append(icon, msg);
    const select = () => {
      if (alarm.targetType === 'network') return;
      uiState.selected = { type: alarm.targetType, id: alarm.targetId };
      uiState.previewAction = null;
      renderGameScreen();
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
    container.appendChild(row);
  }
}

function renderActionLog(state) {
  const container = $('action-log');
  container.replaceChildren();
  if (state.actionHistory.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Još nema odigranih poteza.';
    container.appendChild(p);
    return;
  }
  [...state.actionHistory].reverse().forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'action-log-row';
    row.textContent = `${state.actionHistory.length - i}. ${entry.label} — ${fmtEur(entry.costCents)} — score ${entry.scoreAfter}`;
    container.appendChild(row);
  });
}

function renderStatusBar(state) {
  $('status-score').textContent = String(state.calculated.score);
  $('status-budget').textContent = `${fmtEur(state.budgetRemainingCents)} / ${fmtEur(state.budgetInitialCents)}`;
  $('status-actions').textContent = `${state.actionsRemaining} / ${state.actionsAllowedTotal}`;

  const criticalCount = (state.calculated.alarms || []).filter((a) => a.severity === 'critical').length;
  const warnCount = (state.calculated.alarms || []).filter((a) => a.severity === 'warning').length;
  const alarmsEl = $('status-alarms');
  alarmsEl.textContent = String(criticalCount + warnCount);
  alarmsEl.className = `si-value mono ${criticalCount > 0 ? 'critical' : warnCount > 0 ? 'warn' : 'ok'}`;

  $('status-elapsed').textContent = fmtDuration(currentElapsedSeconds(state));
  $('status-meta').textContent = `${DIFFICULTY[state.difficulty]?.label || state.difficulty} · ${state.seed}`;
}

function renderPrintSummary(state) {
  const container = $('print-summary');
  container.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = `GridFix — ${state.scenario.title}`;
  const meta = document.createElement('p');
  meta.textContent = `Težina: ${DIFFICULTY[state.difficulty]?.label || state.difficulty} · Seed: ${state.seed} · Rezultat: ${state.calculated.score}`;
  container.append(h, meta);
}

// ---------------------------------------------------------------------
// Static control wiring
// ---------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storage.saveSettings({ ...storage.getSettings(), theme });
}

function wireStaticControls() {
  $('btn-home').addEventListener('click', () => { showScreen('start'); refreshStartScreen(); });
  $('btn-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === 'light' ? 'dark' : 'light');
  });

  document.querySelectorAll('.difficulty-card').forEach((card) => {
    card.addEventListener('click', () => startNewGame(card.dataset.difficulty));
  });

  $('btn-continue').addEventListener('click', continueGame);
  $('btn-give-up').addEventListener('click', giveUp);
  $('btn-export-round').addEventListener('click', exportRound);

  $('btn-import').addEventListener('click', () => $('import-file-input').click());
  $('import-file-input').addEventListener('change', async (evt) => {
    const file = evt.target.files?.[0];
    evt.target.value = '';
    if (file) await importRoundFromFile(file);
  });

  $('btn-reset-data').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Resetiraj lokalne podatke?',
      body: 'Ovo trajno briše spremljenu rundu, povijest i najbolje rezultate na ovom uređaju. Ova radnja se ne može poništiti.',
      confirmLabel: 'Resetiraj sve',
      danger: true
    });
    if (!confirmed) return;
    storage.resetAllLocalData();
    store = null;
    stopElapsedTimer();
    refreshStartScreen();
    await messageDialog({ title: 'Gotovo', body: 'Svi lokalni podaci su obrisani.' });
  });
}

boot();
