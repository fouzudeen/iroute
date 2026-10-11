import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FakeValkey } from '../helpers/fake-valkey.js';

/** @type {FakeValkey} */
let client;

beforeEach(() => {
  client = new FakeValkey();
});

describe('FakeValkey', () => {
  test('set/get round-trip', async () => {
    await client.set('k', 'v');
    assert.strictEqual(await client.get('k'), 'v');
  });

  test('set with EX ttl expires', async () => {
    await client.set('k', 'v', { EX: 1 });
    assert.strictEqual(await client.get('k'), 'v');
    client._advance(1001);
    assert.strictEqual(await client.get('k'), null);
  });

  test('incr increments counter', async () => {
    assert.strictEqual(await client.incr('c'), 1);
    assert.strictEqual(await client.incr('c'), 2);
    assert.strictEqual(await client.get('c'), '2');
  });

  test('hset/hgetall stores hashes', async () => {
    await client.hset('h', 'a', '1');
    await client.hset('h', 'b', '2');
    assert.deepStrictEqual(await client.hgetall('h'), { a: '1', b: '2' });
  });

  test('hmset sets multiple fields', async () => {
    await client.hmset('h', { x: '10', y: '20' });
    assert.deepStrictEqual(await client.hgetall('h'), { x: '10', y: '20' });
  });

  test('del removes key', async () => {
    await client.set('k', 'v');
    assert.strictEqual(await client.del('k'), 1);
    assert.strictEqual(await client.get('k'), null);
  });

  test('exists counts existing keys', async () => {
    await client.set('a', '1');
    await client.set('b', '2');
    assert.strictEqual(await client.exists('a', 'b', 'c'), 2);
  });

  test('xadd appends to stream with auto id', async () => {
    const id = await client.xadd('s', '*', { type: 'PREPARE' });
    assert.ok(id.includes('-'));
    const entries = await client.xread('STREAMS', 's', '0-0');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0][1][0][1].type, 'PREPARE');
  });

  test('xread only returns entries after lastId', async () => {
    const id1 = await client.xadd('s', '*', { n: '1' });
    await client.xadd('s', '*', { n: '2' });
    const entries = await client.xread('STREAMS', 's', id1);
    assert.strictEqual(entries[0][1].length, 1);
    assert.strictEqual(entries[0][1][0][1].n, '2');
  });
});
