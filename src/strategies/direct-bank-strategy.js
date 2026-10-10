import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RoutingStrategy } from './strategy.js';
import { createRoutingDecision } from '../types.js';
import { randomUUID } from 'node:crypto';

export class DirectBankStrategy extends RoutingStrategy {
  constructor(options = {}) {
    super('DirectBankStrategy', options);
    this._mappingPath = options.mappingPath || process.env.BIN_MAPPING_PATH || './rules/bin-mapping.json';
    this._version = options.version || '1.0.0';
    this._mapping = null;
  }

  async load() {
    if (this._mapping) return this;
    const content = await readFile(resolve(this._mappingPath), 'utf-8');
    const parsed = JSON.parse(content);
    this._mapping = parsed.mappings || parsed;
    this._loaded = true;
    return this;
  }

  canRoute(context) {
    return Boolean(context.issuerBin) && this._hasMapping(context.issuerBin);
  }

  route(context, { startedAt = Date.now() } = {}) {
    const bin = context.issuerBin;
    const entry = this._mapping[bin];

    if (!entry) {
      throw new Error(`DirectBankStrategy selected but no mapping found for bin ${bin}`);
    }

    const candidates = entry.providers.map((p, index) => ({
      id: p.id,
      type: p.type || 'pgsp',
      weight: p.weight ?? 100 - (index * 10),
      slaMs: p.slaMs,
      score: p.weight ?? 100 - (index * 10),
      bin
    }));

    return createRoutingDecision({
      decisionId: randomUUID(),
      requestId: context.requestId,
      ruleVersion: `bin:${this._version}`,
      candidates,
      excluded: [],
      fallbackUsed: false,
      provenance: {
        strategyName: this.name,
        strategyVersion: this._version,
        evaluatedAt: new Date().toISOString(),
        matchedRules: [`bin:${bin}`],
        contextFingerprint: { issuerBin: bin, bankCode: entry.bankCode }
      },
      latencyMs: Date.now() - startedAt
    });
  }

  _hasMapping(bin) {
    return this._mapping != null && Object.prototype.hasOwnProperty.call(this._mapping, bin);
  }
}
