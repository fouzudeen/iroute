import { getValkeyClient } from './valkey-client.js';

const CONSUMER_GROUP = 'iroute:rule:consumers';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BLOCK_MS = 2000;

/**
 * iroute-side stream consumer for coordinated rule changes.
 *
 * Reads `iroute:rule:changes` and dispatches:
 * - RULE_CHANGE_PREPARE -> load, validate, stage; INCR ready counter.
 * - RULE_CHANGE_COMMIT  -> apply staged package atomically.
 * - RULE_CHANGE_ABORT   -> discard staged package.
 *
 * The consumer uses a consumer group so multiple instances can share the
 * stream without duplicate processing. Each instance has its own consumer name.
 */
export class ChangeConsumer {
  constructor(options = {}) {
    this.valkey = options.valkey || getValkeyClient();
    this.streamKey = options.streamKey || 'iroute:rule:changes';
    this.consumerGroup = options.consumerGroup || CONSUMER_GROUP;
    this.instanceId = options.instanceId || process.env.IRUTE_INSTANCE_ID || `instance-${process.pid}`;
    this.batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    this.blockMs = options.blockMs || DEFAULT_BLOCK_MS;
    this.engine = options.engine || null;
    this._running = false;
    this._pendingChangeId = null;
    this._lastAppliedChangeId = null;
    this._health = { status: 'stopped', lastError: null, processed: 0 };
  }

  /**
   * @param {Object} engine
   * @param {Function} engine.reload
   * @param {Object} [engine._pendingRulePackage]
   * @param {string} [engine.lastAppliedChangeId]
   * @param {Function} [engine.isReady]
   */
  bindEngine(engine) {
    this.engine = engine;
  }

  /**
   * Ensure the consumer group exists, creating the stream if necessary.
   */
  async _ensureGroup() {
    try {
      await this.valkey.xgroup('CREATE', this.streamKey, this.consumerGroup, '$', 'MKSTREAM');
    } catch (err) {
      // Valkey returns BUSYGROUP if the group already exists.
      if (!err.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /**
   * Start consuming the stream in a loop.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    this._health.status = 'running';
    await this._ensureGroup();

    while (this._running) {
      try {
        const replies = await this.valkey.xreadgroup(
          'GROUP', this.consumerGroup, this.instanceId,
          'COUNT', this.batchSize,
          'BLOCK', this.blockMs,
          'STREAMS', this.streamKey, '>'
        );

        if (!replies || replies.length === 0) continue;

        const [, entries] = replies[0];
        for (const [id, fields] of entries) {
          await this._processEntry(id, fields);
          await this.valkey.xack(this.streamKey, this.consumerGroup, id);
        }
      } catch (err) {
        this._health.lastError = err.message;
        // Back off briefly to avoid tight error loops.
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    this._health.status = 'stopped';
  }

  stop() {
    this._running = false;
    this._health.status = 'stopping';
  }

  /**
   * @returns {{status: string, pendingChangeId: string|null, lastAppliedChangeId: string|null, processed: number, lastError: string|null}}
   */
  getHealth() {
    return {
      status: this._health.status,
      pendingChangeId: this._pendingChangeId,
      lastAppliedChangeId: this._lastAppliedChangeId,
      processed: this._health.processed,
      lastError: this._health.lastError
    };
  }

  async _processEntry(id, fields) {
    const payloadIndex = fields.indexOf('payload');
    if (payloadIndex === -1) return;
    const event = JSON.parse(fields[payloadIndex + 1]);

    switch (event.eventType) {
      case 'RULE_CHANGE_PREPARE':
        await this._handlePrepare(event);
        break;
      case 'RULE_CHANGE_COMMIT':
        await this._handleCommit(event);
        break;
      case 'RULE_CHANGE_ABORT':
        await this._handleAbort(event);
        break;
      default:
        // Unknown event types are acknowledged and ignored.
        break;
    }

    this._health.processed += 1;
  }

  async _handlePrepare(event) {
    if (!this.engine) return;

    const { changeId, packageId, treeKey, expectedInstances } = event;

    // Load and validate the package from the store.
    const pkg = await this.engine.loader.store.getPackageById(packageId);
    if (!pkg) {
      throw new Error(`Package ${packageId} not found for change ${changeId}`);
    }

    const valid = this.engine.validator.validate(pkg.rules);
    if (!valid) {
      throw new Error(`Validation failed for package ${packageId}: ${JSON.stringify(this.engine.validator.errors)}`);
    }

    // Stage the package without applying it.
    this.engine._pendingRulePackage = {
      ...pkg.rules,
      version: pkg.version,
      _changeId: changeId,
      _treeKey: treeKey,
      _expectedInstances: expectedInstances
    };
    this._pendingChangeId = changeId;

    // Acknowledge staging by incrementing the ready counter.
    await this.valkey.incr(`iroute:rule:ready:${changeId}`);
  }

  async _handleCommit(event) {
    if (!this.engine) return;
    if (this._pendingChangeId && this._pendingChangeId !== event.changeId) {
      // A different change is staged; do not apply this commit.
      return;
    }

    if (this.engine._pendingRulePackage) {
      this.engine.applyStagedPackage({ changeId: event.changeId });
    }

    this._lastAppliedChangeId = event.changeId;
    this._pendingChangeId = null;
  }

  async _handleAbort(event) {
    if (!this.engine) return;
    if (this._pendingChangeId === event.changeId) {
      this.engine._pendingRulePackage = null;
      this._pendingChangeId = null;
    }
  }
}
