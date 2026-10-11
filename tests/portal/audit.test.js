import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { auditHandler } from '../../src/portal/handlers/audit.js';

let store;

before(() => { store = new SqliteRuleStore({ url: ':memory:' }); });
after(() => { store.close(); });

function send(p) {
  return (status, body) => { p.status = status; p.body = body; };
}

test('audit feed returns recent events', async () => {
  await store.createTree({ treeKey: 'audit-tree', name: 'Audit', criteria: {} });
  const out = {};
  await auditHandler(store, new URLSearchParams(), send(out));
  assert.strictEqual(out.status, 200);
  assert.ok(Array.isArray(out.body.events));
});

test('audit feed filters by treeKey', async () => {
  const t1 = await store.createTree({ treeKey: 'a1', name: 'A1', criteria: {} });
  await store.createTree({ treeKey: 'a2', name: 'A2', criteria: {} });
  const out = {};
  await auditHandler(store, new URLSearchParams({ treeKey: 'a1' }), send(out));
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.events.every(e => e.decisionTreeId === t1.id));
});

test('audit feed limits results', async () => {
  await store.createTree({ treeKey: 'limit-tree', name: 'Limit', criteria: {} });
  const out = {};
  await auditHandler(store, new URLSearchParams({ limit: '1' }), send(out));
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.events.length <= 1);
});
