import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';
import { ChangeCoordinator } from '../../src/events/change-coordinator.js';
import { ChangeConsumer } from '../../src/events/change-consumer.js';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { RuleValidator } from '../../src/rules/validator.js';

/** @type {FakeValkey} */
let client;
let store;

function makeEngine(initialPending = null) {
  const engine = {
    loader: { store },
    validator: new RuleValidator(),
    _rulePackage: { version: '0.0.0', rules: [] },
    _pendingRulePackage: initialPending,
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

describe('Change integration (counter-based 2PC)', () => {
  test('all instances stage before commit', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });

    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50, timeoutMs: 500 });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: pkg.id, expectedInstances: 2
    });

    const engine1 = makeEngine();
    const consumer1 = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer1.bindEngine(engine1);

    const engine2 = makeEngine();
    const consumer2 = new ChangeConsumer({ valkey: client, instanceId: 'i2' });
    consumer2.bindEngine(engine2);

    await consumer1._handlePrepare({ changeId, packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 2 });
    await consumer2._handlePrepare({ changeId, packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 2 });

    assert.strictEqual(await client.get(`iroute:rule:ready:${changeId}`), '2');

    await coordinator.commit(changeId);
    await consumer1._handleCommit({ changeId });
    await consumer2._handleCommit({ changeId });

    assert.strictEqual(engine1._rulePackage.version, '1.0.0');
    assert.strictEqual(engine2._rulePackage.version, '1.0.0');
    assert.strictEqual(engine1.lastAppliedChangeId, changeId);
  });

  test('split-version fleet prevented when one instance does not acknowledge', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });

    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50, timeoutMs: 200 });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: pkg.id, expectedInstances: 2
    });

    const engine1 = makeEngine();
    const consumer1 = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer1.bindEngine(engine1);
    await consumer1._handlePrepare({ changeId, packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 2 });

    const result = await coordinator.monitorReady(changeId);
    assert.strictEqual(result.committed, false);

    // Engine1 still has old package because commit never happened.
    assert.strictEqual(engine1._rulePackage.version, '0.0.0');
  });

  test('timeout aborts pending change', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }]
    }, { publish: true });

    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50, timeoutMs: 100 });

    const engine1 = makeEngine();
    const consumer1 = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer1.bindEngine(engine1);

    // Use runChange for the full lifecycle: prepare → monitor (timeout) → abort.
    const result = await coordinator.runChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: pkg.id, expectedInstances: 2
    });

    assert.strictEqual(result.committed, false);

    // Abort the specific change returned by runChange; instances should discard staging.
    await consumer1._handleAbort({ changeId: result.changeId });
    assert.strictEqual(engine1._pendingRulePackage, null);
  });

  test('invalid package aborts via validation', async () => {
    const tree = await store.createTree({ treeKey: 't', name: 'T', criteria: {} });
    const pkg = await store.publishPackage(tree.id, '1.0.0', {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rules: [{ id: 'r1' }]
    }, { publish: true });

    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50, timeoutMs: 200 });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: pkg.id, expectedInstances: 1
    });

    const engine1 = makeEngine();
    const consumer1 = new ChangeConsumer({ valkey: client, instanceId: 'i1' });
    consumer1.bindEngine(engine1);

    await assert.rejects(
      () => consumer1._handlePrepare({ changeId, packageId: pkg.id, treeKey: 't', version: '1.0.0', expectedInstances: 1 })
    );

    const result = await coordinator.monitorReady(changeId);
    assert.strictEqual(result.committed, false);
  });
});
