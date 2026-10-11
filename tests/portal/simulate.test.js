import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { simulateHandler } from '../../src/portal/handlers/simulate.js';

let store;

before(() => { store = new SqliteRuleStore({ url: ':memory:' }); });
after(() => { store.close(); });

function send(p) {
  return (status, body) => { p.status = status; p.body = body; };
}

test('simulate requires treeKey and version', () => {
  const out = {};
  simulateHandler(store, { version: '1.0.0' }, send(out));
  assert.strictEqual(out.status, 400);
});

test('simulate returns 404 for unknown policy', async () => {
  const out = {};
  await simulateHandler(store, { treeKey: 'missing', version: '1.0.0', context: {} }, send(out));
  assert.strictEqual(out.status, 404);
});

test('simulate returns 404 for unknown version', async () => {
  await store.createTree({ treeKey: 'sim-tree-unknown', name: 'Sim', criteria: {} });
  const out = {};
  await simulateHandler(store, { treeKey: 'sim-tree-unknown', version: '9.9.9', context: {} }, send(out));
  assert.strictEqual(out.status, 404);
});

test('simulate returns candidates for matching rule', async () => {
  const tree = await store.createTree({ treeKey: 'sim-tree', name: 'Sim', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [
      { id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }
    ]
  }, { publish: true });

  const out = {};
  await simulateHandler(store, { treeKey: 'sim-tree', version: '1.0.0', context: { amount: 100, currency: 'eur' } }, send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.matches, 1);
  assert.strictEqual(out.body.candidates[0].pspId, 'psp-eu');
});

test('simulate normalizes context', async () => {
  const tree = await store.createTree({ treeKey: 'norm-tree', name: 'Norm', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [
      { id: 'r1', priority: 10, condition: { operator: 'eq', field: 'country', value: 'DE' }, actions: { providers: [{ id: 'psp-de', type: 'psp', weight: 100 }] } }
    ]
  }, { publish: true });

  const out = {};
  await simulateHandler(store, { treeKey: 'norm-tree', version: '1.0.0', context: { amount: 100, currency: 'EUR', country: 'de' } }, send(out));
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.context.country, 'DE');
});
