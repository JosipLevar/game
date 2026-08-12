// engine/scoring.js
import { SCORE_WEIGHTS } from '../constants.js';

/**
 * Score formula, exactly as specified:
 *   1000
 *   + 100 × each POWERED priority consumer
 *   - 2 × total losses in W
 *   - total cost in € / 10
 *   - 80 × each action used
 *   - 200 × each disconnected priority load
 *   - 500 × each active critical alarm
 */
export function computeScore({ network, calculated, budgetInitialCents, budgetRemainingCents, actionsUsed }) {
  const w = SCORE_WEIGHTS;

  const priorityLoads = network.loads.filter((l) => l.priority);
  const poweredPriorityCount = priorityLoads.filter((l) => l.connected).length;
  const disconnectedPriorityCount = priorityLoads.length - poweredPriorityCount;

  const totalLossesW = Object.values(calculated.edgeLossesW || {}).reduce((sum, w2) => sum + w2, 0);
  const costSpentCents = Math.max(0, budgetInitialCents - budgetRemainingCents);
  const costSpentEUR = costSpentCents / 100;

  const criticalAlarmCount = (calculated.alarms || []).filter((a) => a.severity === 'critical').length;

  let score = w.base;
  score += w.perPriorityConsumerPowered * poweredPriorityCount;
  score -= w.perWattLoss * totalLossesW;
  score -= costSpentEUR / w.costDivisor;
  score -= w.perActionUsed * actionsUsed;
  score -= w.perDisconnectedPriorityLoad * disconnectedPriorityCount;
  score -= w.perActiveCriticalAlarm * criticalAlarmCount;

  return Math.round(score);
}

/**
 * Evaluate whether the round is currently in a winning state.
 * A win is NEVER granted while any critical alarm is active, even if the
 * score would be positive — score and win condition are independent.
 */
export function evaluateWinCondition({ network, calculated, budgetRemainingCents, actionsRemaining }) {
  const reasons = [];

  const criticalAlarms = (calculated.alarms || []).filter((a) => a.severity === 'critical');
  if (criticalAlarms.length > 0) {
    reasons.push('Postoji aktivan kritični alarm.');
  }

  const priorityLoads = network.loads.filter((l) => l.priority);
  const unpoweredPriority = priorityLoads.filter((l) => !l.connected);
  if (unpoweredPriority.length > 0) {
    reasons.push('Nisu svi prioritetni potrošači napajani.');
  }

  if (budgetRemainingCents < 0) {
    reasons.push('Budžet je prekoračen.');
  }

  if (actionsRemaining < 0) {
    reasons.push('Broj dopuštenih intervencija je premašen.');
  }

  return { won: reasons.length === 0, reasons };
}

/**
 * A round is lost when the player has no way left to reach a win: budget
 * or actions are exhausted (or negative) while the win condition still
 * fails. Checked after every committed action.
 */
export function evaluateLossCondition({ winEvaluation, budgetRemainingCents, actionsRemaining }) {
  if (winEvaluation.won) return false;
  if (actionsRemaining <= 0 && budgetRemainingCents >= 0) {
    // No actions left and still not won -> loss.
    return true;
  }
  if (budgetRemainingCents < 0) return true;
  return false;
}
