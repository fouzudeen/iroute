import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../src/repository/sqlite-rule-store.js';
import { RuleLoader } from '../src/rules/loader.js';
import { ForestEvaluator } from '../src/rules/forest-evaluator.js';

let store;

before(() => {
  store = new SqliteRuleStore({ url: ':memory:' });
});

beforeEach(() => {
  store.db.exec(`
    DELETE FROM audit_log;
    DELETE FROM rule_package_activations;
    DELETE FROM rule_packages;
    DELETE FROM decision_trees;
  `);
});

after(() => {
  store.close();
});

test('empty forest evaluate throws', () => {
  const forest = new ForestEvaluator({ trees: [], logger: { child: () => ({}) } });
  assert.throws(() => forest.evaluate({ requestId: 'empty' }), /No decision trees available/);
});

test('rollback with only one version returns null', async () => {
  const tree = await store.createTree({ treeKey: 'single-version', name: 'Single', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.setActive(tree.id, '1.0.0', 'production');

  const rolled = await store.rollback(tree.id, 'production');
  assert.strictEqual(rolled, null);
});

test('getActivePackage returns null when nothing is active', async () => {
  const tree = await store.createTree({ treeKey: 'inactive', name: 'Inactive', criteria: {} });
  const active = await store.getActivePackage(tree.id, 'production');
  assert.strictEqual(active, null);
});

test('loader fallback to files when DB store has no active package', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:' });
  const pkg = await loader.load('latest');
  assert.ok(pkg.version);
  assert.ok(Array.isArray(pkg.rules));
  loader.close();
});

test('loader returns forest aggregate when multiple active trees', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const s = loader.store;

  const eu = await s.createTree({ treeKey: 'eu', name: 'EU', criteria: {} });
  const us = await s.createTree({ treeKey: 'us', name: 'US', criteria: {} });

  await s.publishPackage(eu.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await s.publishPackage(us.id, '2.0.0', { version: '2.0.0', rules: [] }, { publish: true });

  await s.setActive(eu.id, '1.0.0', 'production');
  await s.setActive(us.id, '2.0.0', 'production');

  const pkg = await loader.load('latest');
  assert.strictEqual(pkg.forest, true);
  assert.strictEqual(pkg.trees.length, 2);
  assert.ok(pkg.version.startsWith('forest:'));
  loader.close();
});

test('findMatchingTrees returns empty when no active trees', async () => {
  const matches = await store.findMatchingTrees({ region: 'EU' }, 'production');
  assert.deepStrictEqual(matches, []);
});

test('findMatchingTrees filters out trees with non-matching criteria', async () => {
  const tree = await store.createTree({ treeKey: 'us-only', name: 'US Only', criteria: { region: 'US' } });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.setActive(tree.id, '1.0.0', 'production');

  const matches = await store.findMatchingTrees({ region: 'EU' }, 'production');
  assert.strictEqual(matches.length, 0);
});

test('published but not activated package is not returned by getActivePackage', async () => {
  const tree = await store.createTree({ treeKey: 'published-only', name: 'Published Only', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });

  const active = await store.getActivePackage(tree.id, 'production');
  assert.strictEqual(active, null);
});

test('forest evaluator filters by criteria at route time', () => {
  const euTree = {
    treeKey: 'eu',
    criteria: { region: 'EU' },
    package: {
      version: '1.0.0',
      rules: [{
        id: 'eu-rule',
        priority: 1,
        condition: { operator: 'eq', field: 'currency', value: 'EUR' },
        actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] }
      }]
    }
  };
  const usTree = {
    treeKey: 'us',
    criteria: { region: 'US' },
    package: {
      version: '1.0.0',
      rules: [{
        id: 'us-rule',
        priority: 1,
        condition: { operator: 'eq', field: 'currency', value: 'USD' },
        actions: { providers: [{ id: 'psp-us', type: 'psp', weight: 100 }] }
      }]
    }
  };

  const forest = new ForestEvaluator({ trees: [euTree, usTree], logger: { child: () => ({}) } });
  const result = forest.evaluate({ requestId: 'r1', region: 'US', currency: 'USD' });

  assert.strictEqual(result.treeResults.length, 1);
  assert.strictEqual(result.treeResults[0].treeKey, 'us');
  assert.strictEqual(result.prioritizedProviders[0].id, 'psp-us');
});
