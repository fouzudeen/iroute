import { randomUUID } from 'node:crypto';
import { getValkeyClient } from './valkey-client.js';
import { DistributedLock } from './distributed-lock.js';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LOCK_TTL_SECONDS = 10;
const DEFAULT_POLL_MS = 500;

function writerLockKey(env, scope) {
  return `iroute:rule:writer-lock:${env}:${scope}`;
}

function changeKey(changeId) {
  return `iroute:rule:change:${changeId}`;
}

function readyKey(changeId) {
  return `iroute:rule:ready:${changeId}`;
}

function commitKey(changeId) {
  return `iroute:rule:commit:${changeId}`;
}

/**
 * Portal-side coordinator for counter-based two-phase rule changes.
 *
 * Responsibilities:
 * - Acquire a writer lock per environment/scope.
 * - Create change metadata and initialize the ready counter to 0.
 * - Append RULE_CHANGE_PREPARE to the iroute:rule:changes stream.
 * - Poll the ready counter until all live instances have staged the package.
 * - Append RULE_CHANGE_COMMIT or RULE_CHANGE_ABORT.
 */
export class ChangeCoordinator {
  constructor(options = {}) {
    this.valkey = options.valkey || getValkeyClient();
    this.streamKey = options.streamKey || 'iroute:rule:changes';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.lockTtlSeconds = options.lockTtlSeconds || DEFAULT_LOCK_TTL_SECONDS;
    this.pollMs = options.pollMs || DEFAULT_POLL_MS;
    /**
     * In-process map of writer locks currently held by this coordinator.
     * Keyed by `env:scope`; each lock is released on commit, abort, or timeout.
     * This serializes the whole rule-change lifecycle, not just prepareChange.
     */
    this._heldLocks = new Map();
  }

  /**
   * Count live instances from heartbeat keys.
   * @returns {Promise<number>}
   */
  async countLiveInstances() {
    const keys = await this.valkey.keys('iroute:rule:instance:*');
    if (keys.length === 0) return 1; // tolerate single-node dev mode
    let alive = 0;
    for (const key of keys) {
      const ttl = await this.valkey.ttl(key);
      if (ttl > 0) alive += 1;
    }
    return alive;
  }

  /**
   * Prepare a rule change.
   *
   * @param {Object} params
   * @param {string} params.env
   * @param {string} params.scope
   * @param {string} params.scopeValue
   * @param {string} params.treeKey
   * @param {string} params.version
   * @param {string} params.packageId
   * @param {string} [params.checksum]
   * @param {string} [params.actor]
   * @param {number} [params.expectedInstances]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<{changeId: string, timeoutAt: string}>}
   */
  async prepareChange(params) {
    const {
      env,
      scope,
      scopeValue,
      treeKey,
      version,
      packageId,
      checksum,
      actor = 'portal',
      expectedInstances,
      timeoutMs = this.timeoutMs
    } = params;

    const changeId = randomUUID();
    const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
    const expected = expectedInstances ?? (await this.countLiveInstances());

    const lockKey = writerLockKey(env, scope);

    // If this coordinator instance already holds a writer lock for this env/scope,
    // fail fast to prevent nested/parallel changes.
    if (this._heldLocks.has(lockKey)) {
      throw Object.assign(new Error('Writer lock unavailable'), { code: 'WRITER_LOCK_CONFLICT' });
    }

    const lock = new DistributedLock(lockKey, {
      valkey: this.valkey,
      ttlSeconds: this.lockTtlSeconds
    });

    const acquired = await lock.tryLock();
    if (!acquired) {
      throw Object.assign(new Error('Writer lock unavailable'), { code: 'WRITER_LOCK_CONFLICT' });
    }

    this._heldLocks.set(lockKey, lock);

    try {
      const metadata = {
        treeKey,
        environment: env,
        scope,
        scopeValue: scopeValue || '',
        version,
        packageId,
        checksum: checksum || '',
        expectedInstances: expected,
        timeoutMs,
        timeoutAt
      };

      await this.valkey.hset(changeKey(changeId), metadata);
      await this.valkey.set(readyKey(changeId), '0');
      await this.valkey.set(commitKey(changeId), 'PENDING');

      const event = {
        eventType: 'RULE_CHANGE_PREPARE',
        changeId,
        treeKey,
        environment: env,
        scope,
        scopeValue: scopeValue || '',
        version,
        packageId,
        checksum: checksum || '',
        expectedInstances: expected,
        timeoutMs,
        actor,
        timestamp: new Date().toISOString()
      };

      await this.valkey.xadd(this.streamKey, '*', 'payload', JSON.stringify(event));

      return { changeId, timeoutAt };
    } catch (err) {
      // Release the writer lock immediately on prepare failure so the env/scope
      // is not wedged until the lock TTL expires.
      this._heldLocks.delete(lockKey);
      await lock.release();
      throw err;
    }
    // Intentionally do NOT release the lock on success. It is held until
    // commit()/abort()/runChange() finalizes the change. This serializes the
    // full rule-change lifecycle. See docs/plans/2026-10-10-business-rule-portal-plan.md
    // "Writer lock lifetime concern".
  }

  /**
   * Poll the ready counter until it reaches expectedInstances or timeout.
   * @param {string} changeId
   * @returns {Promise<{ready: number, expected: number, committed: boolean}>}
   */
  async monitorReady(changeId) {
    const start = Date.now();
    const meta = await this.valkey.hgetall(changeKey(changeId));
    if (!meta || Object.keys(meta).length === 0) {
      throw Object.assign(new Error('Change not found'), { code: 'CHANGE_NOT_FOUND' });
    }
    const expected = parseInt(meta.expectedInstances, 10) || 1;
    const timeoutMs = parseInt(meta.timeoutMs, 10) || this.timeoutMs;

    while (Date.now() - start < timeoutMs) {
      const ready = parseInt(await this.valkey.get(readyKey(changeId)) || '0', 10);
      const commit = await this.valkey.get(commitKey(changeId));
      if (commit === 'COMMITTED') {
        return { ready, expected, committed: true };
      }
      if (commit === 'ABORTED') {
        return { ready, expected, committed: false };
      }
      if (ready >= expected) {
        return { ready, expected, committed: true };
      }
      await new Promise(r => setTimeout(r, this.pollMs));
    }

    return { ready: parseInt(await this.valkey.get(readyKey(changeId)) || '0', 10), expected, committed: false };
  }

  /**
   * Commit a prepared change.
   * @param {string} changeId
   * @param {string} [actor]
   * @returns {Promise<{committed: boolean}>}
   */
  async commit(changeId, actor = 'portal') {
    const meta = await this.valkey.hgetall(changeKey(changeId));
    const commit = await this.valkey.get(commitKey(changeId));
    if (commit === 'COMMITTED') return { committed: true };
    if (commit === 'ABORTED') return { committed: false };

    const tx = this.valkey.multi();
    tx.set(commitKey(changeId), 'COMMITTED');
    tx.xadd(this.streamKey, '*', 'payload', JSON.stringify({
      eventType: 'RULE_CHANGE_COMMIT',
      changeId,
      actor,
      timestamp: new Date().toISOString()
    }));
    await tx.exec();

    await this._releaseWriterLock(meta.environment, meta.scope);
    return { committed: true };
  }

  /**
   * Abort a prepared change.
   * @param {string} changeId
   * @param {string} [reason]
   * @param {string} [actor]
   * @returns {Promise<{aborted: boolean}>}
   */
  async abort(changeId, reason = 'operator', actor = 'portal') {
    const meta = await this.valkey.hgetall(changeKey(changeId));
    const commit = await this.valkey.get(commitKey(changeId));
    if (commit === 'COMMITTED') return { aborted: false };
    if (commit === 'ABORTED') {
      await this._releaseWriterLock(meta.environment, meta.scope);
      return { aborted: true };
    }

    const tx = this.valkey.multi();
    tx.set(commitKey(changeId), 'ABORTED');
    tx.xadd(this.streamKey, '*', 'payload', JSON.stringify({
      eventType: 'RULE_CHANGE_ABORT',
      changeId,
      reason,
      actor,
      timestamp: new Date().toISOString()
    }));
    await tx.exec();

    await this._releaseWriterLock(meta.environment, meta.scope);
    return { aborted: true };
  }

  /**
   * Release the in-process and Valkey writer lock for an environment/scope.
   * Idempotent: safe to call multiple times or when no lock is held.
   * @private
   */
  async _releaseWriterLock(env, scope) {
    const lockKey = writerLockKey(env, scope);
    const lock = this._heldLocks.get(lockKey);
    if (lock) {
      await lock.release();
      this._heldLocks.delete(lockKey);
      return;
    }
    // If the in-process reference is missing, best-effort delete the Valkey key
    // so the env/scope is not accidentally wedged. This path is used when
    // recover() is implemented later.
    await this.valkey.del(lockKey);
  }

  /**
   * Get the status of a change.
   * @param {string} changeId
   * @returns {Promise<Object>}
   */
  async getStatus(changeId) {
    const [meta, ready, commit] = await Promise.all([
      this.valkey.hgetall(changeKey(changeId)),
      this.valkey.get(readyKey(changeId)),
      this.valkey.get(commitKey(changeId))
    ]);

    return {
      changeId,
      metadata: meta || {},
      ready: parseInt(ready || '0', 10),
      state: commit || 'UNKNOWN'
    };
  }

  /**
   * Convenience: prepare, monitor, and commit/abort.
   * @param {Object} params
   * @returns {Promise<{changeId: string, committed: boolean, ready: number, expected: number}>}
   */
  async runChange(params) {
    const { changeId } = await this.prepareChange(params);
    try {
      const { ready, expected, committed: readyMet } = await this.monitorReady(changeId);
      if (readyMet) {
        await this.commit(changeId, params.actor);
        return { changeId, committed: true, ready, expected };
      }
      await this.abort(changeId, 'timeout', params.actor);
      return { changeId, committed: false, ready, expected };
    } catch (err) {
      // Ensure the writer lock is released even if monitoring throws unexpectedly.
      const meta = await this.valkey.hgetall(changeKey(changeId));
      if (meta.environment && meta.scope) {
        await this._releaseWriterLock(meta.environment, meta.scope);
      }
      throw err;
    }
  }
}
