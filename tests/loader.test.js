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

test('loader uses region-scoped activation', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const store = loader.store;

  const tree = await store.createTree({ treeKey: 'eu-tree', name: 'EU Tree', criteria: { region: 'EU' } });
  await store.publishPackage(tree.id, '2.0.0', {
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r-eu', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(tree.id, '2.0.0', 'production', 'region', 'DE');

  const pkg = await loader.load('latest', { country: 'DE' });
  assert.strictEqual(pkg.version, '2.0.0');
  assert.ok(Array.isArray(pkg.rules));
  assert.strictEqual(pkg.rules[0].id, 'r-eu');
  loader.close();
});

test('loader falls back to global activation when no region activation matches', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const store = loader.store;

  const globalTree = await store.createTree({ treeKey: 'global', name: 'Global', criteria: {} });
  await store.publishPackage(globalTree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r-global', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-global', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(globalTree.id, '1.0.0', 'production', 'global');

  const pkg = await loader.load('latest', { country: 'FR' });
  assert.strictEqual(pkg.version, '1.0.0');
  assert.strictEqual(pkg.rules[0].id, 'r-global');
  loader.close();
});

test('loader prefers merchant-scoped activation over region/global', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const store = loader.store;

  const globalTree = await store.createTree({ treeKey: 'global', name: 'Global', criteria: {} });
  await store.publishPackage(globalTree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r-global', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-global', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(globalTree.id, '1.0.0', 'production', 'global');

  const merchantTree = await store.createTree({ treeKey: 'merchant-tree', name: 'Merchant Tree', criteria: { merchantId: 'm-123' } });
  await store.publishPackage(merchantTree.id, '3.0.0', {
    version: '3.0.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r-merchant', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-merchant', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(merchantTree.id, '3.0.0', 'production', 'merchant', 'm-123');

  const pkg = await loader.load('latest', { merchant: { id: 'm-123' } });
  assert.strictEqual(pkg.version, '3.0.0');
  assert.strictEqual(pkg.rules[0].id, 'r-merchant');
  loader.close();
});

test('loader.load("latest") without context uses global scope for backward compatibility', async () => {
  const loader = new RuleLoader({ basePath: './rules', dbUrl: ':memory:', environment: 'production' });
  const store = loader.store;

  const tree = await store.createTree({ treeKey: 'compat', name: 'Compat', criteria: {} });
  await store.publishPackage(tree.id, '1.5.0', {
    version: '1.5.0',
    createdAt: new Date().toISOString(),
    rules: [{ id: 'r-compat', priority: 1, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-compat', type: 'psp' }] } }]
  }, { publish: true });
  await store.setActive(tree.id, '1.5.0', 'production', 'global');

  const pkg = await loader.load('latest');
  assert.strictEqual(pkg.version, '1.5.0');
  loader.close();
});
