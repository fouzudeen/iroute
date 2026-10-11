import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IRuleStore } from './rule-store.js';
import { RoutingError } from '../errors/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../store/schema.sql');

function checksum(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

/**
 * SQLite-backed implementation of IRuleStore.
 *
 * All public methods return Promises so a PostgreSQL implementation can be
 * swapped in without changing callers. The schema uses SQLite dialect; a
 * PostgreSQL variant of schema.sql is expected when switching backends.
 */
export class SqliteRuleStore extends IRuleStore {
  /**
   * @param {Object} options
   * @param {string} [options.url] SQLite file path (default ':memory:' if omitted)
   * @param {boolean} [options.verbose]
   */
  constructor(options = {}) {
    super();
    this.url = options.url || ':memory:';
    this.db = new Database(this.url, options.verbose ? { verbose: console.log } : undefined);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  close() {
    this.db.close();
  }

  _migrate() {
    const sql = readFileSync(SCHEMA_PATH, 'utf-8');
    this.db.exec(sql);
  }

  async createTree({ treeKey, name, description = '', criteria = {} }) {
    const id = randomUUID();
    const criteriaJson = JSON.stringify(criteria);
    const stmt = this.db.prepare(
      `INSERT INTO decision_trees (id, tree_key, name, description, criteria_json)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, treeKey, name, description, criteriaJson);
    await this.logAudit({ decisionTreeId: id, action: 'CREATE_TREE', actor: 'system' });
    return this.getTreeByKey(treeKey);
  }

  async getTreeByKey(treeKey) {
    const row = this.db.prepare('SELECT * FROM decision_trees WHERE tree_key = ?').get(treeKey);
    return row ? this._hydrateTree(row) : null;
  }

  async updateTree(id, { name, description, criteria }) {
    this.db.prepare(
      `UPDATE decision_trees
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           criteria_json = COALESCE(?, criteria_json),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(name, description, criteria ? JSON.stringify(criteria) : null, id);
    return this.getTreeById(id);
  }

  async getTreeById(id) {
    const row = this.db.prepare('SELECT * FROM decision_trees WHERE id = ?').get(id);
    return row ? this._hydrateTree(row) : null;
  }

  async listTrees() {
    const rows = this.db.prepare('SELECT * FROM decision_trees ORDER BY tree_key').all();
    return rows.map(r => this._hydrateTree(r));
  }

  async findMatchingTrees(context, env, scope = 'global', scopeValue = '') {
    const activeRows = this.db.prepare(
      `SELECT a.decision_tree_id, a.rule_package_id, a.scope, a.scope_value
       FROM rule_package_activations a
       WHERE a.environment = ? AND a.scope = ? AND a.scope_value = ?`
    ).all(env, scope, scopeValue);

    const trees = [];
    for (const activation of activeRows) {
      const tree = await this.getTreeById(activation.decision_tree_id);
      if (!tree) continue;
      if (this._criteriaMatch(tree.criteria, context)) {
        tree._activationScope = activation.scope;
        trees.push(tree);
      }
    }

    // Sort by specificity: more matching fields first; merchant scope beats region beats global.
    const scopeRank = { merchant: 3, region: 2, global: 1 };
    trees.sort((a, b) => {
      const specDiff = this._specificity(b.criteria) - this._specificity(a.criteria);
      if (specDiff !== 0) return specDiff;
      return (scopeRank[b._activationScope] || 0) - (scopeRank[a._activationScope] || 0);
    });

    return trees;
  }

  async publishPackage(treeId, version, rulesJson, meta = {}) {
    const tree = await this.getTreeById(treeId);
    if (!tree) {
      throw new RoutingError(`Decision tree ${treeId} not found`);
    }

    const id = randomUUID();
    const checksumValue = checksum(rulesJson);
    const publishedAt = meta.publish ? now() : null;
    const description = meta.description || '';
    const createdBy = meta.createdBy || null;

    const stmt = this.db.prepare(
      `INSERT INTO rule_packages (id, decision_tree_id, version, description, rules_json, checksum, created_by, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, treeId, version, description, JSON.stringify(rulesJson), checksumValue, createdBy, publishedAt);

    const pkg = await this.getPackage(treeId, version);
    await this.logAudit({ decisionTreeId: treeId, rulePackageId: id, action: 'PUBLISH', actor: createdBy || 'system', payload: { version, published: meta.publish || false } });
    return pkg;
  }

  async getPackageById(id) {
    const row = this.db.prepare('SELECT * FROM rule_packages WHERE id = ?').get(id);
    return row ? this._hydratePackage(row) : null;
  }

  async getPackage(treeId, version) {
    const row = this.db.prepare(
      'SELECT * FROM rule_packages WHERE decision_tree_id = ? AND version = ?'
    ).get(treeId, version);
    return row ? this._hydratePackage(row) : null;
  }

  async listDrafts(treeId) {
    const rows = this.db.prepare(
      'SELECT * FROM rule_packages WHERE decision_tree_id = ? AND published_at IS NULL ORDER BY created_at DESC'
    ).all(treeId);
    return rows.map(r => this._hydratePackage(r));
  }

  async setPackagePublished(id) {
    this.db.prepare('UPDATE rule_packages SET published_at = datetime(\'now\') WHERE id = ?').run(id);
    return this.getPackageById(id);
  }

  async deletePackage(id) {
    this.db.prepare('DELETE FROM rule_packages WHERE id = ?').run(id);
  }

  async listPackages(treeId) {
    const rows = this.db.prepare(
      'SELECT * FROM rule_packages WHERE decision_tree_id = ? ORDER BY created_at'
    ).all(treeId);
    return rows.map(r => this._hydratePackage(r));
  }

  async setActive(treeId, version, env, scope = 'global', scopeValue = '', actor = 'system') {
    const pkg = await this.getPackage(treeId, version);
    if (!pkg) {
      throw new RoutingError(`Package ${version} not found for tree ${treeId}`);
    }

    const upsert = this.db.prepare(
      `INSERT INTO rule_package_activations (id, decision_tree_id, rule_package_id, environment, scope, scope_value, activated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(decision_tree_id, environment, scope, scope_value)
       DO UPDATE SET rule_package_id = excluded.rule_package_id, activated_at = datetime('now'), activated_by = excluded.activated_by`
    );
    upsert.run(randomUUID(), treeId, pkg.id, env, scope, scopeValue, actor);

    // Update active pointer on tree row for quick lookups.
    this.db.prepare('UPDATE decision_trees SET active_version_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(pkg.id, treeId);

    await this.logAudit({ decisionTreeId: treeId, rulePackageId: pkg.id, action: 'ACTIVATE', actor, payload: { environment: env, scope, scopeValue, version } });
    return pkg;
  }

  async getActivePackage(treeId, env, scope = 'global', scopeValue = '') {
    const row = this.db.prepare(
      `SELECT p.*
       FROM rule_package_activations a
       JOIN rule_packages p ON p.id = a.rule_package_id
       WHERE a.decision_tree_id = ? AND a.environment = ? AND a.scope = ?
         AND a.scope_value = ?`
    ).get(treeId, env, scope, scopeValue);
    return row ? this._hydratePackage(row) : null;
  }

  async rollback(treeId, env, scope = 'global', scopeValue = '') {
    const current = await this.getActivePackage(treeId, env, scope, scopeValue);
    if (!current) {
      return null;
    }

    const previous = this.db.prepare(
      `SELECT p.* FROM rule_packages p
       WHERE p.decision_tree_id = ? AND p.id <> ?
       ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`
    ).get(treeId, current.id);

    if (!previous) {
      return null;
    }

    const pkg = await this._hydratePackage(previous);
    await this.setActive(treeId, pkg.version, env, scope, scopeValue, 'system');
    await this.logAudit({ decisionTreeId: treeId, rulePackageId: pkg.id, action: 'ROLLBACK', actor: 'system', payload: { fromVersion: current.version, toVersion: pkg.version, environment: env, scope, scopeValue } });
    return pkg;
  }

  async listAudit(treeKey = null, limit = 20) {
    let rows;
    if (treeKey) {
      const tree = await this.getTreeByKey(treeKey);
      const treeId = tree ? tree.id : null;
      rows = this.db.prepare(
        'SELECT * FROM audit_log WHERE decision_tree_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(treeId, limit);
    } else {
      rows = this.db.prepare(
        'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?'
      ).all(limit);
    }
    return rows.map(r => this._hydrateAudit(r));
  }

  async logAudit({ decisionTreeId = null, rulePackageId = null, action, actor = 'system', payload = {} }) {
    const stmt = this.db.prepare(
      `INSERT INTO audit_log (id, decision_tree_id, rule_package_id, action, actor, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(randomUUID(), decisionTreeId, rulePackageId, action, actor, JSON.stringify(payload));
  }

  _hydrateTree(row) {
    return {
      id: row.id,
      treeKey: row.tree_key,
      name: row.name,
      description: row.description,
      criteria: JSON.parse(row.criteria_json),
      activeVersionId: row.active_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _hydratePackage(row) {
    const rules = JSON.parse(row.rules_json);
    const expected = checksum(rules);
    if (row.checksum && row.checksum !== expected) {
      throw new RoutingError(`Checksum mismatch for package ${row.id}@${row.version}; expected ${expected}, got ${row.checksum}`);
    }
    return {
      id: row.id,
      decisionTreeId: row.decision_tree_id,
      version: row.version,
      description: row.description,
      rules,
      checksum: row.checksum,
      createdBy: row.created_by,
      createdAt: row.created_at,
      publishedAt: row.published_at
    };
  }

  _hydrateAudit(row) {
    return {
      id: row.id,
      decisionTreeId: row.decision_tree_id,
      rulePackageId: row.rule_package_id,
      action: row.action,
      actor: row.actor,
      payload: JSON.parse(row.payload_json || '{}'),
      createdAt: row.created_at
    };
  }

  _criteriaMatch(criteria, context) {
    for (const [key, expected] of Object.entries(criteria)) {
      const actual = context[key];
      if (actual === undefined || actual === null || actual === '') {
        return false;
      }
      if (Array.isArray(expected)) {
        if (!expected.includes(actual)) return false;
      } else if (actual !== expected) {
        return false;
      }
    }
    return true;
  }

  _specificity(criteria) {
    return Object.keys(criteria).length;
  }
}
