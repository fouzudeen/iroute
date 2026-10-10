import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RoutingError, RuleNotFoundError } from '../errors/errors.js';
import { SqliteRuleStore } from '../repository/sqlite-rule-store.js';

/**
 * Loads rule packages from an RDBMS-backed store with file-based fallback.
 *
 * When a database URL is configured (RULE_STORE_DB_URL) the loader queries the
 * active package(s) for the requested environment (RULE_ENVIRONMENT). Otherwise
 * it falls back to the original local/remote JSON file behaviour.
 *
 * For `latest`, the loader loads all active trees for the environment and lets
 * the engine's ForestEvaluator filter by context at route time. This avoids
 * binding tree selection to the load call, which has no payment context.
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

  async load(version = 'latest') {
    if (this.store && version === 'latest') {
      return this._loadActiveFromStore();
    }
    if (this.remoteUrl) {
      return this._loadRemote(version);
    }
    return this._loadLocal(version);
  }

  async _loadActiveFromStore() {
    // Load all active trees for this environment/scope; criteria filtering
    // happens at evaluation time when the payment context is known.
    const trees = await this.store.findMatchingTrees({}, this.environment, 'global');
    if (trees.length === 0) {
      return this._loadLocal('latest');
    }

    const treePackages = [];
    for (const tree of trees) {
      const active = await this.store.getActivePackage(tree.id, this.environment, 'global');
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
      version: `forest:${this.environment}`,
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
