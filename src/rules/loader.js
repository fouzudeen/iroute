import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RoutingError, RuleNotFoundError } from '../errors/errors.js';
import { SqliteRuleStore } from '../repository/sqlite-rule-store.js';

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE'
]);

/**
 * @typedef {Object} PaymentContext
 * @property {string} [country] ISO country code (e.g. 'DE').
 * @property {string} [region]
 * @property {Object} [merchant]
 * @property {string} merchant.id Merchant identifier.
 */

/**
 * Loads rule packages from an RDBMS-backed store with file-based fallback.
 *
 * When a database URL is configured (RULE_STORE_DB_URL) the loader queries the
 * active package(s) for the requested environment (RULE_ENVIRONMENT), scoped by
 * the payment context. Otherwise it falls back to the original local/remote JSON
 * file behaviour.
 *
 * For `latest`, the loader loads all active trees for the resolved scope and lets
 * the engine's ForestEvaluator filter by context at route time. This avoids
 * binding tree selection to the load call, which has limited payment context.
 *
 * Scope resolution order (most specific first):
 *   1. merchant: scopeValue = context.merchant.id
 *   2. region:   scopeValue = context.country
 *   3. global:   scopeValue = ''
 */
export class RuleLoader {
  constructor({
    basePath = process.env.RULE_STORE_PATH || './rules',
    remoteUrl = process.env.RULE_STORE_URL,
    dbUrl = process.env.RULE_STORE_DB_URL,
    environment = process.env.RULE_ENVIRONMENT || 'production'
  } = {}) {
    this.basePath = basePath;
    this.remoteUrl = remoteUrl;
    this.environment = environment;
    this.store = dbUrl ? new SqliteRuleStore({ url: dbUrl }) : null;
  }

  /**
   * Resolve the most specific scope and scopeValue for a payment context.
   *
   * Precedence: merchant > region > global.
   *
   * @param {PaymentContext} [context]
   * @returns {{ scope: string, scopeValue: string }}
   */
  resolveScope(context = {}) {
    if (context.merchant?.id) {
      return { scope: 'merchant', scopeValue: context.merchant.id };
    }
    if (context.country) {
      return { scope: 'region', scopeValue: context.country };
    }
    return { scope: 'global', scopeValue: '' };
  }

  /**
   * Derive a region value from a country code.
   *
   * @param {string} [country]
   * @returns {string|undefined}
   */
  _regionFromCountry(country) {
    if (!country) return undefined;
    const code = String(country).toUpperCase();
    if (EU_COUNTRIES.has(code)) return 'EU';
    return undefined;
  }

  /**
   * Build the context passed to the store, enriching it with derived criteria
   * that the store does not compute itself. Trees can match on `region` or
   * `merchantId` criteria while scope resolution is based on country/merchant.
   *
   * @param {PaymentContext} [context]
   * @returns {PaymentContext}
   */
  _storeContext(context = {}) {
    const derived = {};
    const region = context.region || this._regionFromCountry(context.country);
    if (region) {
      derived.region = region;
    }
    if (context.merchant?.id && context.merchantId === undefined) {
      derived.merchantId = context.merchant.id;
    }
    return Object.keys(derived).length > 0 ? { ...context, ...derived } : context;
  }

  /**
   * Load a rule package or forest.
   *
   * @param {string} [version='latest']
   * @param {PaymentContext} [context] Optional payment context for scope resolution.
   *                                   When omitted, global scope is used.
   * @returns {Promise<Object>}
   */
  async load(version = 'latest', context) {
    if (this.store && version === 'latest') {
      return this._loadActiveFromStore(context);
    }
    if (this.remoteUrl) {
      return this._loadRemote(version);
    }
    return this._loadLocal(version);
  }

  async _loadActiveFromStore(context) {
    // Try the most specific scope first, falling back through region to global.
    const scopes = [
      { scope: 'merchant', scopeValue: context?.merchant?.id },
      { scope: 'region', scopeValue: context?.country },
      { scope: 'global', scopeValue: '' }
    ].filter(s => s.scopeValue !== undefined && s.scopeValue !== null);

    const storeContext = this._storeContext(context);
    for (const { scope, scopeValue } of scopes) {
      const trees = await this.store.findMatchingTrees(storeContext, this.environment, scope, scopeValue);
      if (trees.length > 0) {
        return this._buildPackage(trees, scope, scopeValue);
      }
    }

    return this._loadLocal('latest');
  }

  async _buildPackage(trees, scope, scopeValue) {
    const treePackages = [];
    for (const tree of trees) {
      const active = await this.store.getActivePackage(tree.id, this.environment, scope, scopeValue);
      if (!active) continue;
      treePackages.push({
        treeKey: tree.treeKey,
        criteria: tree.criteria,
        package: { version: active.version, ...active.rules }
      });
    }

    if (treePackages.length === 0) {
      return this._loadLocal('latest');
    }

    // Single active tree: preserve legacy package shape for compatibility.
    if (treePackages.length === 1) {
      return { version: treePackages[0].package.version, ...treePackages[0].package };
    }

    return {
      version: `forest:${this.environment}:${scope}`,
      forest: true,
      trees: treePackages
    };
  }

  async _loadLocal(version) {
    const file = version === 'latest'
      ? 'latest.json'
      : `rules-${version}.json`;
    const path = resolve(this.basePath, file);
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new RuleNotFoundError(version);
      }
      throw new RoutingError(`Failed to load rule package ${version}: ${err.message}`);
    }
  }

  async _loadRemote(version) {
    const url = new URL(`/rules/${version}`, this.remoteUrl).toString();
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        throw new RuleNotFoundError(version);
      }
      throw new RoutingError(`Remote rule store returned ${res.status} for ${version}`);
    }
    return res.json();
  }

  close() {
    this.store?.close();
  }
}
