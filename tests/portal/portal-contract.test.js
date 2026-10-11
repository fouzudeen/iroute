import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { portalRouter } from '../../src/portal/portal-server.js';

let store;
let server;
let baseUrl;

before(async () => {
  store = new SqliteRuleStore({ url: ':memory:' });
  const tree = await store.createTree({ treeKey: 'contract-tree', name: 'Contract', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [
      { id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }
    ]
  }, { publish: true });
  await store.setActive(tree.id, '1.0.0', 'production', 'global');

  const app = createServer((req, res) => portalRouter(store, { environment: 'production' })(req, res));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

async function req(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('GET /portal/api/policies returns policies array', async () => {
  const { status, body } = await req('/portal/api/policies');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.policies));
});

test('POST /portal/api/policies creates a policy', async () => {
  const { status, body } = await req('/portal/api/policies', {
    method: 'POST',
    body: JSON.stringify({ treeKey: 'new-policy', name: 'New', criteria: {} })
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.policy.treeKey, 'new-policy');
});

test('GET /portal/api/policies/:treeKey returns policy', async () => {
  const { status, body } = await req('/portal/api/policies/contract-tree');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.policy.treeKey, 'contract-tree');
});

test('POST /portal/api/policies/:treeKey/draft returns version and checksum', async () => {
  const { status, body } = await req('/portal/api/policies/contract-tree/draft', {
    method: 'POST',
    body: JSON.stringify({ version: '1.1.0', rules: [{ id: 'r2', priority: 5, condition: { operator: 'eq', field: 'currency', value: 'USD' }, actions: { providers: [{ id: 'psp-us', type: 'psp', weight: 100 }] } }] })
  });
  assert.strictEqual(status, 201);
  assert.ok(body.version);
  assert.ok(body.checksum);
});

test('POST /portal/api/policies/:treeKey/publish activates version', async () => {
  const { status, body } = await req('/portal/api/policies/contract-tree/publish', {
    method: 'POST',
    body: JSON.stringify({ version: '1.0.0' })
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.activated, '1.0.0');
});

test('GET /portal/api/policies/:treeKey/history returns versions', async () => {
  const { status, body } = await req('/portal/api/policies/contract-tree/history');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.versions));
});

test('POST /portal/api/simulate returns candidates', async () => {
  const { status, body } = await req('/portal/api/simulate', {
    method: 'POST',
    body: JSON.stringify({ treeKey: 'contract-tree', version: '1.0.0', context: { amount: 100, currency: 'EUR' } })
  });
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.candidates));
});

test('GET /portal/api/audit returns events', async () => {
  const { status, body } = await req('/portal/api/audit');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.events));
});

test('unknown portal route returns 404', async () => {
  const { status } = await req('/portal/api/unknown');
  assert.strictEqual(status, 404);
});
