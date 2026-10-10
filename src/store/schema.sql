-- iRule RDBMS schema for Forest of Decision Trees
-- SQLite today; PostgreSQL migration later is a dialect change only.

CREATE TABLE IF NOT EXISTS decision_trees (
  id TEXT PRIMARY KEY,
  tree_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
  active_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rule_packages (
  id TEXT PRIMARY KEY,
  decision_tree_id TEXT NOT NULL REFERENCES decision_trees(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  description TEXT,
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  checksum TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE(decision_tree_id, version)
);

CREATE INDEX IF NOT EXISTS idx_rule_packages_tree ON rule_packages(decision_tree_id);

CREATE TABLE IF NOT EXISTS rule_package_activations (
  id TEXT PRIMARY KEY,
  decision_tree_id TEXT NOT NULL REFERENCES decision_trees(id) ON DELETE CASCADE,
  rule_package_id TEXT NOT NULL REFERENCES rule_packages(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  scope_value TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_by TEXT,
  UNIQUE(decision_tree_id, environment, scope, scope_value)
);

CREATE INDEX IF NOT EXISTS idx_activations_env ON rule_package_activations(environment, scope, scope_value);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  decision_tree_id TEXT REFERENCES decision_trees(id) ON DELETE SET NULL,
  rule_package_id TEXT REFERENCES rule_packages(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_tree ON audit_log(decision_tree_id);
CREATE INDEX IF NOT EXISTS idx_audit_package ON audit_log(rule_package_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
