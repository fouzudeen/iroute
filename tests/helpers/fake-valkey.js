/**
 * Lightweight in-memory Valkey fake for tests.
 * Implements the subset of Valkey commands used by the rule-change event modules.
 */
export class FakeValkey {
  constructor() {
    this._data = new Map();
    this._streams = new Map(); // streamName -> [{ id, fields }]
    this._ttl = new Map();
    this._streamIdCounter = 0;
  }

  _now() {
    return Date.now();
  }

  _isExpired(key) {
    const exp = this._ttl.get(key);
    return exp !== undefined && exp <= this._now();
  }

  _cleanup(key) {
    if (this._isExpired(key)) {
      this._data.delete(key);
      this._ttl.delete(key);
      return true;
    }
    return false;
  }

  async connect() {
    return this;
  }

  async disconnect() {
    this._data.clear();
    this._streams.clear();
    this._ttl.clear();
  }

  async ping() {
    return 'PONG';
  }

  _parseTokens(tokens) {
    const opts = {};
    for (let i = 0; i < tokens.length; i += 2) {
      const key = String(tokens[i]).toUpperCase();
      const value = tokens[i + 1];
      if (key === 'EX' || key === 'PX' || key === 'NX' || key === 'XX') {
        opts[key] = value !== undefined ? Number(value) : true;
      }
    }
    return opts;
  }

  async set(key, value, ...tokens) {
    const options = tokens.length === 1 && typeof tokens[0] === 'object'
      ? tokens[0]
      : this._parseTokens(tokens);
    if (options.NX && (this._data.has(key) || this._streams.has(key)) && !this._isExpired(key)) {
      return null;
    }
    this._cleanup(key);
    this._data.set(key, String(value));
    if (options.EX || options.PX) {
      const ms = (options.EX || 0) * 1000 + (options.PX || 0);
      this._ttl.set(key, this._now() + ms);
    }
    return 'OK';
  }

  async setex(key, seconds, value) {
    return this.set(key, value, 'EX', seconds);
  }

  async get(key) {
    if (this._cleanup(key)) return null;
    return this._data.get(key) ?? null;
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys) {
      this._cleanup(key);
      if (this._data.has(key) || this._streams.has(key)) {
        this._data.delete(key);
        this._streams.delete(key);
        this._ttl.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async exists(...keys) {
    let count = 0;
    for (const key of keys) {
      if (!this._cleanup(key) && (this._data.has(key) || this._streams.has(key))) {
        count++;
      }
    }
    return count;
  }

  async scan(cursor, ...args) {
    const matchIdx = args.findIndex(a => String(a).toUpperCase() === 'MATCH');
    const pattern = matchIdx !== -1 ? args[matchIdx + 1] : '*';
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const allKeys = [
      ...Array.from(this._data.keys()),
      ...Array.from(this._streams.keys())
    ].filter(k => regex.test(k));
    return ['0', allKeys];
  }

  async expire(key, seconds) {
    if (this._cleanup(key)) return 0;
    if (!this._data.has(key) && !this._streams.has(key)) return 0;
    this._ttl.set(key, this._now() + seconds * 1000);
    return 1;
  }

  async ttl(key) {
    if (this._cleanup(key)) return -2;
    const exp = this._ttl.get(key);
    if (exp === undefined) return -1;
    return Math.max(0, Math.ceil((exp - this._now()) / 1000));
  }

  async incr(key) {
    this._cleanup(key);
    const current = Number(this._data.get(key) ?? 0);
    const next = current + 1;
    this._data.set(key, String(next));
    return next;
  }

  async hset(key, field, value) {
    this._cleanup(key);
    let hash = this._data.get(key);
    if (!hash || typeof hash !== 'object') {
      hash = {};
      this._data.set(key, hash);
    }
    if (typeof field === 'object' && value === undefined) {
      for (const [k, v] of Object.entries(field)) {
        hash[k] = String(v);
      }
    } else {
      hash[field] = String(value);
    }
    return 1;
  }

  async hgetall(key) {
    if (this._cleanup(key)) return {};
    return this._data.get(key) ?? {};
  }

  async hmset(key, entries) {
    for (const [field, value] of Object.entries(entries)) {
      await this.hset(key, field, value);
    }
    return 'OK';
  }

  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const matched = [];
    for (const key of this._data.keys()) {
      if (!this._isExpired(key) && regex.test(key)) matched.push(key);
    }
    return matched;
  }

  async eval(script, keyCount, ...args) {
    const keys = args.slice(0, keyCount);
    const argv = args.slice(keyCount);
    const key = keys[0];
    const value = await this.get(key);
    if (script.includes('expire')) {
      if (value === argv[0]) {
        await this.expire(key, Number(argv[1]));
        return 1;
      }
      return 0;
    }
    if (value === argv[0]) {
      await this.del(key);
      return 1;
    }
    return 0;
  }

  multi() {
    const client = this;
    const commands = [];
    return {
      hset(key, obj) { commands.push(['hset', key, obj]); return this; },
      set(key, value) { commands.push(['set', key, value]); return this; },
      xadd(stream, id, field, value) { commands.push(['xadd', stream, id, field, value]); return this; },
      async exec() {
        const results = [];
        for (const [cmd, ...args] of commands) {
          if (cmd === 'hset') {
            await client.hset(args[0], args[1]);
            results.push(['OK']);
          } else if (cmd === 'set') {
            await client.set(args[0], args[1]);
            results.push(['OK']);
          } else if (cmd === 'xadd') {
            const id = await client.xadd(args[0], args[1], args[2], args[3]);
            results.push([id]);
          }
        }
        return results;
      }
    };
  }

  async xadd(key, id, ...rest) {
    if (!this._streams.has(key)) {
      this._streams.set(key, []);
    }
    let entryId = id;
    if (id === '*') {
      this._streamIdCounter += 1;
      entryId = `${this._now()}-${this._streamIdCounter}`;
    }
    const entries = this._streams.get(key);
    const payload = {};
    // Support both xadd(stream, '*', { payload: '...' }) and xadd(stream, '*', 'payload', '...').
    if (rest.length === 1 && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      Object.assign(payload, rest[0]);
    } else if (rest.length === 1 && Array.isArray(rest[0])) {
      const fields = rest[0];
      for (let i = 0; i < fields.length; i += 2) {
        payload[fields[i]] = fields[i + 1];
      }
    } else {
      for (let i = 0; i < rest.length; i += 2) {
        payload[rest[i]] = rest[i + 1];
      }
    }
    const entry = { id: entryId, fields: payload };
    entries.push(entry);
    return entryId;
  }

  async xread(...args) {
    let streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) streamsIdx = args.indexOf('streams');
    if (streamsIdx === -1 || streamsIdx + 2 > args.length) return [];

    const streamName = args[streamsIdx + 1];
    const lastId = args[streamsIdx + 2];
    const entries = this._streams.get(streamName) ?? [];
    const filtered = entries.filter(e => this._compareId(e.id, lastId) > 0);
    if (filtered.length === 0) return [];
    return [[streamName, filtered.map(e => [e.id, e.fields])]];
  }

  _compareId(a, b) {
    if (a === '>' || b === '>') return 1;
    const [aMs, aSeq] = String(a).split('-').map(Number);
    const [bMs, bSeq] = String(b).split('-').map(Number);
    if (aMs !== bMs) return aMs - bMs;
    return aSeq - bSeq;
  }

  async xgroup(..._args) {
    return 'OK';
  }

  async xreadgroup(...args) {
    const streamsIdx = args.findIndex(a => String(a).toUpperCase() === 'STREAMS');
    if (streamsIdx === -1 || streamsIdx + 2 > args.length) return [];
    const streamName = args[streamsIdx + 1];
    const lastId = args[streamsIdx + 2];
    const entries = this._streams.get(streamName) ?? [];
    const filtered = entries.filter(e => this._compareId(e.id, lastId) > 0);
    if (filtered.length === 0) return [];
    return [[streamName, filtered.map(e => [e.id, e.fields])]];
  }

  async xack(_stream, _group, ..._ids) {
    return 1;
  }

  /** For tests: advance TTL clock. */
  _advance(ms) {
    const now = this._now();
    for (const key of this._ttl.keys()) {
      if (this._ttl.get(key) <= now + ms) {
        this._data.delete(key);
        this._ttl.delete(key);
      }
    }
  }
}
