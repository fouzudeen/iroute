import { getValkeyClient } from './valkey-client.js';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TTL_SECONDS = 10;

/**
 * Publish a periodic heartbeat for this iroute instance.
 *
 * Writes `iroute:rule:instance:{instanceId}` with a TTL so the portal can
 * count live instances before starting a coordinated rule change.
 */
export class InstanceHeartbeat {
  constructor(options = {}) {
    this.instanceId = options.instanceId || process.env.IRUTE_INSTANCE_ID || `instance-${process.pid}`;
    this.valkey = options.valkey || getValkeyClient();
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS;
    this._timer = null;
    this._stopped = true;
  }

  async start() {
    if (!this._stopped) return;
    this._stopped = false;
    await this._beat();
    this._timer = setInterval(() => {
      this._beat().catch(() => {});
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _beat() {
    try {
      await this.valkey.setex(
        `iroute:rule:instance:${this.instanceId}`,
        this.ttlSeconds,
        new Date().toISOString()
      );
    } catch (err) {
      // Heartbeat failures are non-fatal; the consumer will log elsewhere.
      if (!this._stopped) {
        throw err;
      }
    }
  }

  get instanceKey() {
    return `iroute:rule:instance:${this.instanceId}`;
  }
}
