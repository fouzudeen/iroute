import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../src/repository/sqlite-rule-store.js';

let store;

before(() => {
  store = new SqliteRuleStore({ url: ':memory:' });
});

after(() => {
  store.close();
});

test('createTree stores and returns a tree', async () => {
  const tree = await store.createTree({
    treeKey: 'eu-cards',
    name: 'EU Card Rules',
    description: 'Rules for EU card transactions',
    criteria: { region: 'EU', paymentMethod: 'card' }
  });

  assert.ok(tree.id);
  assert.strictEqual(tree.treeKey, 'eu-cards');
  assert.deepStrictEqual(tree.criteria, { region: 'EU', paymentMethod: 'card' });
});

test('getTreeByKey returns null for missing key', async () => {
  assert.strictEqual(await store.getTreeByKey('missing'), null);
});

test('publishPackage creates a versioned package', async () => {
  const tree = await store.createTree({
    treeKey: 'us-wallets',
    name: 'US Wallet Rules',
    criteria: { region: 'US', paymentMethod: 'wallet' }
  });

  const pkg = await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r1', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'USD' }, actions: { providers: [{ id: 'psp-us', type: 'psp' }] } }]
  }, { description: 'initial', publish: true, createdBy: 'alice' });

  assert.strictEqual(pkg.version, '1.0.0');
  assert.ok(pkg.checksum);
  assert.strictEqual(pkg.createdBy, 'alice');
});

test('setActive and getActivePackage resolve active version', async () => {
  const tree = await store.createTree({ treeKey: 'global-cards', name: 'Global Cards', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.publishPackage(tree.id, '1.1.0', { version: '1.1.0', rules: [] }, { publish: true });

  await store.setActive(tree.id, '1.1.0', 'production', 'global', '', 'alice');
  const active = await store.getActivePackage(tree.id, 'production', 'global');

  assert.strictEqual(active.version, '1.1.0');
});

test('rollback reverts to previous version', async () => {
  const tree = await store.createTree({ treeKey: 'rollback-tree', name: 'Rollback', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.publishPackage(tree.id, '1.1.0', { version: '1.1.0', rules: [] }, { publish: true });
  await store.setActive(tree.id, '1.1.0', 'production');

  const rolled = await store.rollback(tree.id, 'production');
  assert.strictEqual(rolled.version, '1.0.0');

  const active = await store.getActivePackage(tree.id, 'production');
  assert.strictEqual(active.version, '1.0.0');
});

test('findMatchingTrees filters by criteria and environment', async () => {
  const eu = await store.createTree({ treeKey: 'eu-match', name: 'EU', criteria: { region: 'EU' } });
  const us = await store.createTree({ treeKey: 'us-match', name: 'US', criteria: { region: 'US' } });

  await store.publishPackage(eu.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.publishPackage(us.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.setActive(eu.id, '1.0.0', 'production');
  await store.setActive(us.id, '1.0.0', 'production');

  const matching = await store.findMatchingTrees({ region: 'EU' }, 'production');
  const euMatches = matching.filter(t => t.treeKey === 'eu-match');
  assert.strictEqual(euMatches.length, 1);
  assert.strictEqual(euMatches[0].treeKey, 'eu-match');
});

test('logAudit writes entries', async () => {
  const tree = await store.createTree({ treeKey: 'audit-tree', name: 'Audit', criteria: {} });
  await store.logAudit({ decisionTreeId: tree.id, action: 'MANUAL_AUDIT', actor: 'bob', payload: { note: 'test' } });

  const rows = store.db.prepare('SELECT * FROM audit_log WHERE decision_tree_id = ? AND action = ?').all(tree.id, 'MANUAL_AUDIT');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].action, 'MANUAL_AUDIT');
});

test('scope-specific activations do not collide', async () => {
  const tree = await store.createTree({ treeKey: 'scoped-tree', name: 'Scoped', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', rules: [] }, { publish: true });
  await store.publishPackage(tree.id, '1.1.0', { version: '1.1.0', rules: [] }, { publish: true });

  await store.setActive(tree.id, '1.0.0', 'production', 'region', 'EU');
  await store.setActive(tree.id, '1.1.0', 'production', 'region', 'US');

  const euActive = await store.getActivePackage(tree.id, 'production', 'region', 'EU');
  const usActive = await store.getActivePackage(tree.id, 'production', 'region', 'US');

  assert.strictEqual(euActive.version, '1.0.0');
  assert.strictEqual(usActive.version, '1.1.0');
});

test('hydrated package verifies checksum', async () => {
  const tree = await store.createTree({ treeKey: 'checksum-tree', name: 'Checksum', criteria: {} });
  const pkg = await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r1', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'USD' }, actions: { providers: [{ id: 'psp-us', type: 'psp' }] } }]
  }, { publish: true });

  // Tamper with stored rules_json to simulate corruption.
  store.db.prepare('UPDATE rule_packages SET rules_json = ? WHERE id = ?').run('{"tampered":true}', pkg.id);

  await assert.rejects(
    () => store.getPackage(tree.id, '1.0.0'),
    /Checksum mismatch/
  );
});
