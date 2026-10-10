import { test } from 'node:test';
import assert from 'node:assert';
import { ForestEvaluator } from '../src/rules/forest-evaluator.js';

const euTree = {
  treeKey: 'eu-cards',
  criteria: { region: 'EU', paymentMethod: 'card' },
  package: {
    version: '1.0.0',
    rules: [
      {
        id: 'eu-visa',
        priority: 10,
        condition: { operator: 'eq', field: 'country', value: 'DE' },
        actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] }
      }
    ]
  }
};

const usTree = {
  treeKey: 'us-cards',
  criteria: { region: 'US', paymentMethod: 'card' },
  package: {
    version: '2.0.0',
    rules: [
      {
        id: 'us-visa',
        priority: 10,
        condition: { operator: 'eq', field: 'country', value: 'US' },
        actions: { providers: [{ id: 'psp-us', type: 'psp', weight: 90 }] }
      }
    ]
  }
};

test('ForestEvaluator merges candidates from multiple trees', () => {
  const forest = new ForestEvaluator({ trees: [euTree, usTree], logger: { child: () => ({}) } });

  const result = forest.evaluate({ requestId: 'r1', country: 'DE', region: 'EU', paymentMethod: 'card' });

  assert.strictEqual(result.matches, 1);
  assert.strictEqual(result.prioritizedProviders[0].id, 'psp-eu');
  assert.ok(result.version.startsWith('forest:'));
  assert.ok(result.treeResults.some(t => t.treeKey === 'eu-cards'));
});

test('ForestEvaluator de-duplicates providers keeping highest score', () => {
  const dupeTree = {
    treeKey: 'eu-wallets',
    criteria: { region: 'EU', paymentMethod: 'wallet' },
    package: {
      version: '1.0.0',
      rules: [
        {
          id: 'eu-wallet',
          priority: 5,
          condition: { operator: 'eq', field: 'country', value: 'DE' },
          actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 50 }] }
        }
      ]
    }
  };

  const forest = new ForestEvaluator({ trees: [euTree, dupeTree], logger: { child: () => ({}) } });
  const result = forest.evaluate({ requestId: 'r2', country: 'DE', region: 'EU', paymentMethod: 'card' });

  const pspEu = result.prioritizedProviders.filter(p => p.id === 'psp-eu');
  assert.strictEqual(pspEu.length, 1);
  assert.strictEqual(pspEu[0].score, 10100);
});

test('ForestEvaluator throws when no trees are loaded', () => {
  const forest = new ForestEvaluator({ trees: [], logger: { child: () => ({}) } });
  assert.throws(() => forest.evaluate({ requestId: 'r3' }), /No decision trees available/);
});

test('ForestEvaluator throws when no tree matches context', () => {
  const forest = new ForestEvaluator({ trees: [euTree, usTree], logger: { child: () => ({}) } });
  assert.throws(() => forest.evaluate({ requestId: 'r4', country: 'JP', region: 'APAC', paymentMethod: 'card' }), /No decision trees matched the payment context/);
});
