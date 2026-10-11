import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';
import { DistributedLock } from '../../src/events/distributed-lock.js';

/** @type {FakeValkey} */
let client;

beforeEach(() => {
  client = new FakeValkey();
});

describe('DistributedLock', () => {
  test('acquire returns true when lock free', async () => {
    const lock = new DistributedLock('lock:test', { valkey: client, token: 'a' });
    assert.strictEqual(await lock.tryLock(), true);
  });

  test('acquire returns false when lock held', async () => {
    const first = new DistributedLock('lock:test', { valkey: client, token: 'a' });
    await first.tryLock();
    const second = new DistributedLock('lock:test', { valkey: client, token: 'b' });
    assert.strictEqual(await second.tryLock(), false);
  });

  test('release deletes lock only for owner', async () => {
    const owner = new DistributedLock('lock:test', { valkey: client, token: 'a' });
    await owner.tryLock();
    const thief = new DistributedLock('lock:test', { valkey: client, token: 'b' });
    assert.strictEqual(await thief.release(), false);
    assert.strictEqual(await owner.release(), true);
    assert.strictEqual(await owner.tryLock(), true);
  });

  test('extend refreshes ttl for owner', async () => {
    const lock = new DistributedLock('lock:test', { valkey: client, token: 'a', ttlSeconds: 2 });
    await lock.tryLock();
    assert.strictEqual(await lock.extend(10), true);
    assert.strictEqual(await client.ttl('lock:test'), 10);
  });

  test('extend fails for non-owner', async () => {
    const owner = new DistributedLock('lock:test', { valkey: client, token: 'a' });
    await owner.tryLock();
    const thief = new DistributedLock('lock:test', { valkey: client, token: 'b' });
    assert.strictEqual(await thief.extend(10), false);
  });
});
