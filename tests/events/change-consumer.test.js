import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';
import { ChangeConsumer } from '../../src/events/change-consumer.js';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { RuleValidator } from '../../src/rules/validator.js';

/** @type {FakeValkey} */
let client;
let store;

function makeEngine() {
  const engine = {
    loader: { store },
    validator: new RuleValidator(),
    _pendingRulePackage: null,
    lastAppliedChangeId: null,
    applyStagedPackage({ changeId }) {
      this._rulePackage = this._pendingRulePackage;
      this._pendingRulePackage = null;
      this.lastAppliedChangeId = changeId;
    },
    isReady() {
      return this._pendingRulePackage === null;
    }
  };
  return engine;
}

beforeEach(async () => {
  client = new FakeValkey();
  store = new SqliteRuleStore({ url: ':memory:' });
});

describe('ChangeConsumer', () => {
  test('prepare loads and stages package and increments ready', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });

    const consumer = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer.bindEngine(makeEngine());

    await consumer._handlePrepare({ changeId: 'c1', packageId: pkg.id, checksum: pkg.checksum, treeKey: 't', version: '1.0.0', expectedInstances: 1 });

    assert.ok(consumer.engine._pendingRulePackage);
    assert.strictEqual(consumer._pendingChangeId, 'c1');
    assert.strictEqual(await client.get('iroute:rule:ready:c1'), '1');
  });

  test('prepare rejects invalid package and does not increment ready', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1' }]
    }, { publish: true });

    const consumer = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer.bindEngine(makeEngine());

    await assert.rejects(
      () => consumer._handlePrepare({ changeId: 'c1', packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 1 }),
      /Validation failed/
    );
    assert.strictEqual(await client.get('iroute:rule:ready:c1'), null);
  });

  test('commit applies staged package', async () => {
    const consumer = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    const engine = makeEngine();
    engine._pendingRulePackage = { version: '1.0.0', rules: [] };
    consumer.bindEngine(engine);
    consumer._pendingChangeId = 'c1';

    await consumer._handleCommit({ changeId: 'c1' });

    assert.strictEqual(engine.lastAppliedChangeId, 'c1');
    assert.strictEqual(engine._pendingRulePackage, null);
    assert.strictEqual(consumer._pendingChangeId, null);
  });

  test('abort discards staged package', async () => {
    const consumer = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    const engine = makeEngine();
    engine._pendingRulePackage = { version: '1.0.0', rules: [] };
    consumer.bindEngine(engine);
    consumer._pendingChangeId = 'c1';

    await consumer._handleAbort({ changeId: 'c1' });

    assert.strictEqual(engine._pendingRulePackage, null);
    assert.strictEqual(consumer._pendingChangeId, null);
  });

  test('consumer processes stream entry', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });

    const consumer = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer.bindEngine(makeEngine());

    await client.xadd('iroute:rule:changes', '*', 'payload', JSON.stringify({ eventType: 'RULE_CHANGE_PREPARE', changeId: 'c1', packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 1 }));

    await consumer._processEntry('1-0', ['payload', JSON.stringify({ eventType: 'RULE_CHANGE_PREPARE', changeId: 'c1', packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 1 })]);

    assert.strictEqual(consumer._health.processed, 1);
  });
});
