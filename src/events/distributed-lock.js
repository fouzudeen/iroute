import { getValkeyClient } from './valkey-client.js';

const DEFAULT_TTL_SECONDS = 10;

/**
 * Distributed lock backed by Valkey SET key value NX EX.
 *
 * The lock is owned by a token (random UUID) and can only be released or
 * extended by the same token. Auto-extend is not performed; callers must
 * explicitly call extend() while work is ongoing.
 */
export class DistributedLock {
  constructor(key, options = {}) {
    this.key = key;
    this.valkey = options.valkey || getValkeyClient();
    this.token = options.token || crypto.randomUUID();
    this.ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS;
    this._held = false;
  }

  /**
   * Try to acquire the lock.
   * @returns {Promise<boolean>}
   */
  async tryLock() {
    const acquired = await this.valkey.set(this.key, this.token, 'EX', this.ttlSeconds, 'NX');
    this._held = acquired === 'OK';
    return this._held;
  }

  /**
   * Release the lock only if the token matches.
   * @returns {Promise<boolean>}
   */
  async release() {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const released = await this.valkey.eval(script, 1, this.key, this.token);
    this._held = false;
    return released === 1;
  }

  /**
   * Extend the lock TTL if the token still owns it.
   * @param {number} [ttlSeconds]
   * @returns {Promise<boolean>}
   */
  async extend(ttlSeconds) {
    const ttl = ttlSeconds || this.ttlSeconds;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const extended = await this.valkey.eval(script, 1, this.key, this.token, String(ttl));
    this._held = extended === 1;
    return this._held;
  }

  get held() {
    return this._held;
  }
}
