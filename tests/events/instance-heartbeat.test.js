import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';
import { InstanceHeartbeat } from '../../src/events/instance-heartbeat.js';

/** @type {FakeValkey} */
let client;

beforeEach(() => {
  client = new FakeValkey();
});

describe('InstanceHeartbeat', () => {
  test('beat registers instance with ttl', async () => {
    const hb = new InstanceHeartbeat({ valkey: client, instanceId: 'i1', ttlSeconds: 10 });
    await hb._beat();
    assert.strictEqual(await client.exists(hb.instanceKey), 1);
    assert.ok((await client.ttl(hb.instanceKey)) > 0);
  });

  test('start schedules repeated beats', async () => {
    const hb = new InstanceHeartbeat({ valkey: client, instanceId: 'i2', intervalMs: 50, ttlSeconds: 10 });
    await hb.start();
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(await client.exists(hb.instanceKey), 1);
    hb.stop();
  });

  test('stop clears timer', async () => {
    const hb = new InstanceHeartbeat({ valkey: client, instanceId: 'i3', ttlSeconds: 10 });
    await hb.start();
    hb.stop();
    assert.strictEqual(hb._timer, null);
    assert.strictEqual(hb._stopped, true);
  });
});
