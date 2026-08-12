import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScenario } from '../js/engine/scenario-generator.js';
import cablesArr from '../js/data/cables.json' with { type: 'json' };
import transformersArr from '../js/data/transformers.json' with { type: 'json' };
import scenarioMeta from '../js/data/scenarios.json' with { type: 'json' };

const cablesById = Object.fromEntries(cablesArr.map((c) => [c.id, c]));
const transformersById = Object.fromEntries(transformersArr.map((t) => [t.id, t]));

function gen(seed, difficultyId) {
  return generateScenario({ seed, difficultyId, cablesById, transformersById, scenarioMeta });
}

test('same seed produces an identical network, every time', () => {
  const a = gen(424242, 'operator');
  const b = gen(424242, 'operator');
  assert.deepEqual(a.network, b.network);
  assert.deepEqual(a.scenario, b.scenario);
  assert.equal(a.budgetInitialCents, b.budgetInitialCents);
  assert.equal(a.actionsAllowed, b.actionsAllowed);
});

test('different seeds produce different networks (sanity — not a hard guarantee, but should hold in practice)', () => {
  const a = gen(1, 'operator');
  const b = gen(2, 'operator');
  assert.notDeepEqual(a.network, b.network);
});

test('every generated round across all difficulties is a valid tree with a confirmed alarm per injected event', () => {
  const difficulties = ['beginner', 'operator', 'projektant'];
  for (const difficultyId of difficulties) {
    for (let seed = 0; seed < 40; seed++) {
      const result = gen(seed * 7919 + 13, difficultyId);
      assert.equal(result.valid, true, `seed set ${seed}/${difficultyId} must produce a valid tree`);
      assert.ok(result.calculated.valid, `load flow must succeed for seed set ${seed}/${difficultyId}`);

      // At least one priority load must exist so the win condition is meaningful.
      assert.ok(result.network.loads.some((l) => l.priority), `must have >=1 priority load (${difficultyId} seed ${seed})`);

      // Every declared event should correspond to a real, currently-active alarm
      // of a compatible type, proving the fault is genuine and not cosmetic.
      for (const event of result.scenario.events) {
        const compatibleTypes = {
          'voltage-drop': ['undervoltage'],
          'cable-overload': ['cable-overload'],
          'transformer-overload': ['transformer-overload'],
          'poor-power-factor': ['cable-overload'] // may show as edge warning/critical from bad cosPhi
        };
        const wanted = compatibleTypes[event.type] || [];
        const found = result.calculated.alarms.some((a) => wanted.includes(a.type));
        assert.ok(found, `event ${event.type} (${difficultyId} seed ${seed}) must have a matching active alarm`);
      }
    }
  }
});

test('budget and action allowances match the requested difficulty tier', () => {
  const beginner = gen(5, 'beginner');
  const projektant = gen(5, 'projektant');
  assert.ok(beginner.budgetInitialCents > projektant.budgetInitialCents, 'beginner should have more budget slack');
  assert.ok(beginner.actionsAllowed >= projektant.actionsAllowed, 'beginner should have at least as many actions');
});
