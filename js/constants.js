// constants.js
// Single source of truth for every tunable number in the game.
// Nothing in UI or engine code should hardcode a threshold, cost, or limit —
// it must be read from here so the config can be tuned without touching logic.

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  nominalVoltageV: 400,
  minVoltagePct: 90,
  warningVoltagePct: 93,
  maxCableLoadingPct: 100,
  warningCableLoadingPct: 85,
  maxTransformerLoadingPct: 100,
  warningTransformerLoadingPct: 85
};

// All money in integer cents. Never floats.
export const DIFFICULTY = {
  beginner: {
    id: 'beginner',
    label: 'Početnik',
    budgetInitialCents: 2_500_000, // 25.000 €
    actionsAllowed: 6,
    feederCountRange: [1, 1],
    nodesPerFeederRange: [2, 3],
    problemCountRange: [1, 1]
  },
  operator: {
    id: 'operator',
    label: 'Operater',
    budgetInitialCents: 1_800_000, // 18.000 €
    actionsAllowed: 5,
    feederCountRange: [1, 2],
    nodesPerFeederRange: [2, 4],
    problemCountRange: [1, 2]
  },
  projektant: {
    id: 'projektant',
    label: 'Projektant',
    budgetInitialCents: 1_200_000, // 12.000 €
    actionsAllowed: 4,
    feederCountRange: [2, 3],
    nodesPerFeederRange: [3, 5],
    problemCountRange: [2, 3]
  }
};

// Intervention action identifiers
export const ACTION_TYPES = {
  REPLACE_CABLE: 'replace_cable',
  SHORTEN_LINE: 'shorten_line',
  TRANSFER_LOAD: 'transfer_load',
  DISCONNECT_LOAD: 'disconnect_load',
  ADD_COMPENSATION: 'add_compensation',
  UPGRADE_TRANSFORMER: 'upgrade_transformer'
};

export const ACTION_LABELS = {
  [ACTION_TYPES.REPLACE_CABLE]: 'Zamijeni kabel',
  [ACTION_TYPES.SHORTEN_LINE]: 'Skrati vod',
  [ACTION_TYPES.TRANSFER_LOAD]: 'Prebaci potrošač',
  [ACTION_TYPES.DISCONNECT_LOAD]: 'Isključi neprioritetni teret',
  [ACTION_TYPES.ADD_COMPENSATION]: 'Dodaj kompenzaciju',
  [ACTION_TYPES.UPGRADE_TRANSFORMER]: 'Pojačaj TS'
};

// Cost bands, in integer cents. "Srednje/visoko" etc. resolved to concrete
// numbers here so the engine never has to interpret a fuzzy label.
export const ACTION_COSTS = {
  [ACTION_TYPES.REPLACE_CABLE]: { min: 180_000, max: 480_000 }, // scales with cable tier jump
  [ACTION_TYPES.SHORTEN_LINE]: { flat: 520_000 },
  [ACTION_TYPES.TRANSFER_LOAD]: { flat: 60_000 },
  [ACTION_TYPES.DISCONNECT_LOAD]: { flat: 20_000 },
  [ACTION_TYPES.ADD_COMPENSATION]: { flat: 150_000 },
  [ACTION_TYPES.UPGRADE_TRANSFORMER]: { flat: 900_000 }
};

// Compensation can improve a load's effective cosφ but never past this cap,
// and never past unity power factor.
export const COMPENSATION_MAX_COSPHI = 0.98;
export const COMPENSATION_STEP = 0.12; // improvement applied per use

// "Skrati vod" reduces cable length by this fraction, only where the
// scenario explicitly flags the edge as shortenable.
export const SHORTEN_LINE_FACTOR = 0.4; // cuts length by 40%

export const SCORE_WEIGHTS = {
  base: 1000,
  perPriorityConsumerPowered: 100,
  perWattLoss: 2,
  costDivisor: 10, // score penalty = costEUR / 10
  perActionUsed: 80,
  perDisconnectedPriorityLoad: 200,
  perActiveCriticalAlarm: 500
};

export const STORAGE_KEYS = {
  activeGame: 'gridfix.activeGame.v1',
  history: 'gridfix.history.v1',
  highScores: 'gridfix.highScores.v1',
  settings: 'gridfix.settings.v1'
};

export const MAX_HISTORY_ENTRIES = 50;
export const MAX_HIGHSCORE_ENTRIES = 10;
