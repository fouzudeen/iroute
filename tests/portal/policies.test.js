import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { policiesHandler } from '../../src/portal/handlers/policies.js';

let store;

before(() => { store = new SqliteRuleStore({ url: ':memory:' }); });
after(() => { store.close(); });

function send(p) {
  return (status, body) => { p.status = status; p.body = body; };
}

test('list policies returns empty array', async () => {
  const out = {};
  await policiesHandler.list(store, { environment: 'production' }, send(out));
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.policies, []);
});

test('create policy then list', async () => {
  const created = {};
  await policiesHandler.create(store, { treeKey: 'eu-cards', name: 'EU Cards', criteria: { region: 'EU' } }, send(created));
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.policy.treeKey, 'eu-cards');

  const listed = {};
  await policiesHandler.list(store, { environment: 'production' }, send(listed));
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.policies.length, 1);
});

test('create requires treeKey and name', async () => {
  const out = {};
  await policiesHandler.create(store, { name: 'Missing Key' }, send(out));
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.code, 'INVALID_REQUEST');
});

test('get policy returns 404 for unknown treeKey', async () => {
  const out = {};
  await policiesHandler.get(store, 'no-such-tree', send(out));
  assert.strictEqual(out.status, 404);
});

test('update policy metadata', async () => {
  await store.createTree({ treeKey: 'upd', name: 'Upd', criteria: {} });
  const out = {};
  await policiesHandler.update(store, 'upd', { name: 'Updated', description: 'd', criteria: { region: 'US' } }, send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.policy.name, 'Updated');
  assert.deepStrictEqual(out.body.policy.criteria, { region: 'US' });
});

test('saveDraft stores unpublished package', async () => {
  const tree = await store.createTree({ treeKey: 'draft-tree', name: 'Draft', criteria: {} });
  const out = {};
  await policiesHandler.saveDraft(store, 'draft-tree', {
    version: '2.0.0',
    rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
  }, send(out));
  assert.strictEqual(out.status, 201);
  assert.ok(out.body.checksum);

  const pkg = await store.getPackage(tree.id, '2.0.0');
  assert.strictEqual(pkg.publishedAt, null);
});

test('saveDraft rejects invalid rules', async () => {
  await store.createTree({ treeKey: 'bad-draft', name: 'Bad', criteria: {} });
  const out = {};
  await policiesHandler.saveDraft(store, 'bad-draft', { rules: [{ id: 'r1' }] }, send(out));
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.code, 'VALIDATION_ERROR');
});

test('publish activates and records audit', async () => {
  const tree = await store.createTree({ treeKey: 'pub-tree', name: 'Pub', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
  }, { publish: false });

  const out = {};
  await policiesHandler.publish(store, 'pub-tree', { version: '1.0.0', createdBy: 'alice' }, send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.activated, '1.0.0');
  assert.strictEqual(out.body.policy.liveVersion.version, '1.0.0');
});

test('rollback restores previous version', async () => {
  const tree = await store.createTree({ treeKey: 'rb-tree', name: 'Rb', criteria: {} });
  for (const v of ['1.0.0', '1.1.0']) {
    await store.publishPackage(tree.id, v, {
      version: v,
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });
  }
  await store.setActive(tree.id, '1.1.0', 'production', 'global');

  const out = {};
  await policiesHandler.rollback(store, 'rb-tree', send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.rolledBackTo, '1.0.0');
});

test('rollback fails when no previous version', async () => {
  const tree = await store.createTree({ treeKey: 'rb-fail', name: 'Rb', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', createdAt: new Date().toISOString(), rules: [] }, { publish: true });
  await store.setActive(tree.id, '1.0.0', 'production', 'global');

  const out = {};
  await policiesHandler.rollback(store, 'rb-fail', send(out));
  assert.strictEqual(out.status, 422);
  assert.strictEqual(out.body.code, 'ROLLBACK_FAILED');
});

test('history lists versions in order', async () => {
  const tree = await store.createTree({ treeKey: 'hist-tree', name: 'Hist', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', { version: '1.0.0', createdAt: new Date().toISOString(), rules: [] }, { publish: true });
  await store.publishPackage(tree.id, '1.1.0', { version: '1.1.0', createdAt: new Date().toISOString(), rules: [] }, { publish: true });
  await store.setActive(tree.id, '1.1.0', 'production', 'global');

  const out = {};
  await policiesHandler.history(store, 'hist-tree', send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.versions.length, 2);
  const active = out.body.versions.find(v => v.isActive);
  assert.strictEqual(active.version, '1.1.0');
});
