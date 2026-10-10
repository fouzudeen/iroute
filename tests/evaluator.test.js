import { test } from 'node:test';
import assert from 'node:assert';
import { DecisionTreeEvaluator } from '../src/rules/evaluator.js';

const pkg = {
  version: '1.0.0',
  rules: [
    {
      id: 'eu-visa',
      priority: 10,
      condition: {
        operator: 'and',
        conditions: [
          { operator: 'eq', field: 'country', value: 'DE' },
          { operator: 'eq', field: 'cardBrand', value: 'visa' }
        ]
      },
      actions: {
        providers: [{ id: 'psp-a', type: 'psp', weight: 100 }]
      }
    },
    {
      id: 'default',
      priority: 1,
      condition: { operator: 'eq', field: 'currency', value: 'EUR' },
      actions: {
        providers: [{ id: 'psp-b', type: 'psp', weight: 50 }]
      }
    }
  ]
};

test('evaluator matches EU visa rule', () => {
  const evaluator = new DecisionTreeEvaluator(pkg, { child: () => ({}) });
  const result = evaluator.evaluate({ requestId: 'r1', country: 'DE', cardBrand: 'visa', currency: 'EUR' });
  assert.strictEqual(result.matches, 2);
  assert.strictEqual(result.prioritizedProviders[0].id, 'psp-a');
});

test('evaluator returns default when no match', () => {
  const evaluator = new DecisionTreeEvaluator(pkg, { child: () => ({}) });
  const result = evaluator.evaluate({ requestId: 'r2', country: 'US', cardBrand: 'visa', currency: 'EUR' });
  assert.strictEqual(result.matches, 1);
  assert.strictEqual(result.prioritizedProviders[0].id, 'psp-b');
});
