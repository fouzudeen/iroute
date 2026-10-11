import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';
import { ChangeCoordinator } from '../../src/events/change-coordinator.js';

/** @type {FakeValkey} */
let client;

beforeEach(() => {
  client = new FakeValkey();
});

describe('ChangeCoordinator', () => {
  test('prepareChange creates metadata and streams event', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50 });
    const { changeId } = await coordinator.prepareChange({
      env: 'production',
      scope: 'global',
      treeKey: 'eu-cards',
      version: '1.3.0',
      packageId: 'pkg-1',
      checksum: 'abc',
      expectedInstances: 2
    });

    const status = await coordinator.getStatus(changeId);
    assert.strictEqual(status.state, 'PENDING');
    assert.strictEqual(status.ready, 0);
    assert.strictEqual(status.metadata.treeKey, 'eu-cards');

    const entries = await client.xread('STREAMS', 'iroute:rule:changes', '0-0');
    assert.strictEqual(entries[0][1].length, 1);
    const event = JSON.parse(entries[0][1][0][1].payload);
    assert.strictEqual(event.eventType, 'RULE_CHANGE_PREPARE');
    assert.strictEqual(event.changeId, changeId);
  });

  test('writer lock serializes concurrent changes', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client });
    await coordinator.prepareChange({ env: 'production', scope: 'global', treeKey: 't1', version: '1.0.0', packageId: 'p1' });

    const second = new ChangeCoordinator({ valkey: client });
    await assert.rejects(
      () => second.prepareChange({ env: 'production', scope: 'global', treeKey: 't2', version: '2.0.0', packageId: 'p2' }),
      { code: 'WRITER_LOCK_CONFLICT' }
    );
  });

  test('monitorReady returns committed when counter reaches expected', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50 });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: 'p', expectedInstances: 2
    });

    await client.incr(`iroute:rule:ready:${changeId}`);
    await client.incr(`iroute:rule:ready:${changeId}`);

    const result = await coordinator.monitorReady(changeId);
    assert.strictEqual(result.ready, 2);
    assert.strictEqual(result.committed, true);
  });

  test('commit appends RULE_CHANGE_COMMIT', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: 'p'
    });
    await coordinator.commit(changeId);

    const status = await coordinator.getStatus(changeId);
    assert.strictEqual(status.state, 'COMMITTED');

    const entries = await client.xread('STREAMS', 'iroute:rule:changes', '0-0');
    const commitEvent = entries[0][1].find(e => JSON.parse(e[1].payload).eventType === 'RULE_CHANGE_COMMIT');
    assert.ok(commitEvent);
  });

  test('abort appends RULE_CHANGE_ABORT', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client });
    const { changeId } = await coordinator.prepareChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: 'p'
    });
    await coordinator.abort(changeId, 'operator');

    const status = await coordinator.getStatus(changeId);
    assert.strictEqual(status.state, 'ABORTED');

    const entries = await client.xread('STREAMS', 'iroute:rule:changes', '0-0');
    const abortEvent = entries[0][1].find(e => JSON.parse(e[1].payload).eventType === 'RULE_CHANGE_ABORT');
    assert.ok(abortEvent);
    assert.strictEqual(JSON.parse(abortEvent[1].payload).reason, 'operator');
  });

  test('runChange commits when all instances ready', async () => {
    const coordinator = new ChangeCoordinator({ valkey: client, pollMs: 50, timeoutMs: 500 });

    const runPromise = coordinator.runChange({
      env: 'production', scope: 'global', treeKey: 't', version: '1.0.0', packageId: 'p', expectedInstances: 1
    });

    // Wait briefly so prepareChange creates the change metadata, then increment ready.
    await new Promise(r => setTimeout(r, 60));
    const statuses = await client.keys('iroute:rule:commit:*');
    const changeId = statuses[0].replace('iroute:rule:commit:', '');
    await client.incr(`iroute:rule:ready:${changeId}`);

    const result = await runPromise;
    assert.strictEqual(result.committed, true);
    assert.strictEqual(result.ready, 1);

    const status = await coordinator.getStatus(result.changeId);
    assert.strictEqual(status.state, 'COMMITTED');
  });
});
