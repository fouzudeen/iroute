import { test } from 'node:test';
import assert from 'node:assert';
import { RuleLoader } from '../src/rules/loader.js';

test('loader loads latest package from local store', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  const pkg = await loader.load('latest');
  assert.ok(pkg.version);
  assert.ok(Array.isArray(pkg.rules));
  loader.close();
});

test('loader loads specific version from local store', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  const pkg = await loader.load('1.2.0');
  assert.strictEqual(pkg.version, '1.2.0');
  loader.close();
});

test('loader throws RuleNotFoundError for missing version', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  await assert.rejects(() => loader.load('99.99.99'), /Rule package 99.99.99 not found/);
  loader.close();
});

test('loader loads active package from in-memory store', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const store = loader.store;

  const tree = await store.createTree({ treeKey: 'global', name: 'Global', criteria: {} });
  await store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r1', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eur', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(tree.id, '1.0.0', 'production');

  const pkg = await loader.load('latest');
  assert.strictEqual(pkg.version, '1.0.0');
  assert.ok(Array.isArray(pkg.rules));
  loader.close();
});

test('loader falls back to files when store has no active tree', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:' });
  const pkg = await loader.load('latest');
  assert.ok(pkg.version);
  assert.ok(Array.isArray(pkg.rules));
  loader.close();
});
