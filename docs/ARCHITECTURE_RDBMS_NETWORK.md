# iRoute Architecture Addendum — RDBMS Rule Store & Network of Decision Trees

## 1. Problem Statement

The current file-based rule store (`rules/*.json`) does not scale for larger rule volumes or multi-tenant deployments. Business Teams need:

- A durable, queryable rule store that supports concurrent editing, versioning, and rollback.
- The ability to swap storage technology (SQLite today, PostgreSQL/MySQL tomorrow) without rewriting business logic.
- A way to avoid versioning, packaging, and publishing the **entire** rule set when only a small subset changes.

## 2. Design Goals

1. **RDBMS-backed persistence** with an ORM abstraction so the storage engine can change later.
2. **SQLite for local development/testing**, with a migration path to PostgreSQL.
3. **Network of Decision Trees** — partition rules into independent trees by criteria (e.g. region, payment method, merchant tier) so each tree can be versioned and published independently.
4. **Backward compatibility** with the existing `RoutingEngine`, `RuleLoader`, and packaging workflow.
5. **No runtime schema lock-in** — keep the in-memory evaluator unchanged; load trees from RDBMS into the existing AST.

## 3. Entity Model

```
DecisionTree
  - id (PK)
  - tree_key (unique, e.g. "eu-cards", "us-wallets")
  - name
  - description
  - criteria_json (selector criteria: {"region": "EU", "paymentMethod": "card"})
  - active_version_id (FK -> RulePackage)
  - created_at, updated_at

RulePackage
  - id (PK)
  - decision_tree_id (FK)
  - version (semver, unique per tree)
  - description
  - rules_json (serialized decision tree rules)
  - checksum
  - created_by
  - created_at
  - published_at (nullable)

RulePackageActivation
  - id (PK)
  - decision_tree_id (FK)
  - rule_package_id (FK)
  - environment (dev/staging/production)
  - scope (global / region / merchant)
  - scope_value (e.g. "EU", "m-123")
  - activated_at
  - activated_by

AuditLog
  - id (PK)
  - decision_tree_id (FK, nullable)
  - rule_package_id (FK, nullable)
  - action (CREATE_TREE / PUBLISH / ACTIVATE / ROLLBACK / DELETE)
  - actor
  - payload_json
  - created_at
```

## 4. Network of Decision Trees

A **forest** is a collection of `DecisionTree`s. For a given payment context, a **tree selector** picks the subset of trees whose `criteria_json` matches the context. Trees are evaluated in selector-priority order until one or more produce candidates.

### Selection algorithm

1. Normalize the payment context.
2. Query all active trees for the target environment/scope.
3. Filter trees whose `criteria_json` predicates match the context.
4. Sort matched trees by specificity (most specific first, e.g. merchant-specific > region-specific > global).
5. Evaluate each matched tree using the existing `DecisionTreeEvaluator`.
6. Merge results:
   - Combine candidates across trees, preserving per-tree scores.
   - De-duplicate by provider id, keeping the highest score.
   - Apply global tie-breakers (score, priority, SLA).

### Independent versioning

- Each `DecisionTree` has its own semver lineage (`tree.version`).
- Publishing a new `RulePackage` for one tree does not affect other trees.
- Activations are per-tree, so rolling out a change to "EU cards" does not require republishing "US wallets".

## 5. Repository Abstraction (ORM)

Use **Prisma** or **Drizzle** as the ORM. SQLite is the default provider; switching to PostgreSQL is a connection-string change plus migration.

```typescript
interface IRuleStore {
  // Trees
  createTree(tree: DecisionTreeInput): Promise<DecisionTree>;
  listTrees(): Promise<DecisionTree[]>;
  findMatchingTrees(context: PaymentContext, env: string, scope: Scope): Promise<DecisionTree[]>;

  // Packages
  publishPackage(treeId: string, version: string, rulesJson: object, meta: PublishMeta): Promise<RulePackage>;
  getPackage(treeId: string, version: string): Promise<RulePackage>;
  listPackages(treeId: string): Promise<RulePackage[]>;

  // Activations
  setActive(treeId: string, version: string, env: string, scope: Scope): Promise<void>;
  getActivePackage(treeId: string, env: string, scope: Scope): Promise<RulePackage | null>;
  rollback(treeId: string, env: string, scope: Scope): Promise<RulePackage | null>;

  // Audit
  logAudit(entry: AuditEntry): Promise<void>;
}
```

## 6. Component Changes

| Component | Change |
|-----------|--------|
| `RuleLoader` | Back it with `IRuleStore` instead of file system; fall back to files if store unavailable. |
| `RulePackager` | Persist packages to DB and generate JSON artifacts only when needed for export/CI. |
| `RoutingEngine` | Load a forest (network) of active trees instead of a single package; evaluate selector + evaluator. |
| `RuleBasedStrategy` | Accept a forest loader and run network selection. |
| `Business Portal` | CRUD for trees and packages; activate per tree; audit log viewer. |

## 7. Migration Path

1. Add Prisma/Drizzle schema and migrations.
2. Seed the DB from existing `rules/*.json` files via a one-time import script.
3. Update `RuleLoader` to read from DB first, files as fallback.
4. Introduce `NetworkEvaluator` alongside existing single-tree evaluator.
5. Update CI to validate DB seed instead of only JSON files.
6. Eventually remove file-based packages once the portal and DB workflows are proven.

## 8. Trade-offs & Open Questions

- **SQLite** is sufficient for single-node/local dev but should be replaced with PostgreSQL for production multi-node deployments (write conflicts, concurrent activations).
- **Tree criteria overlap**: if two trees match, specificity ordering resolves it; document the ordering rules clearly.
- **Forest merge semantics**: define how scores/priorities from different trees combine (sum, max, replace).
- **Performance**: cache active forest in memory; DB hit only on activation changes or cache miss.

## 9. Acceptance Criteria

- [x] Rules are persisted in SQLite via an ORM abstraction (`IRuleStore` / `SqliteRuleStore`).
- [x] Same codebase can switch to PostgreSQL by replacing the `IRuleStore` implementation.
- [x] Multiple decision trees can be created, versioned, and activated independently.
- [x] `ForestEvaluator` evaluates the matching forest and returns a merged, prioritized provider list.
- [x] Existing file-based loader continues to work as a fallback (`RULE_STORE_PATH`).
- [x] Tests cover repository CRUD, tree selection, forest evaluation, and rollback.

## 10. Implemented Files

| File | Responsibility |
|---|---|
| `src/store/schema.sql` | SQLite DDL for `decision_trees`, `rule_packages`, `rule_package_activations`, `audit_log`. |
| `src/repository/rule-store.js` | `IRuleStore` interface; swapping to PostgreSQL only requires a new implementation. |
| `src/repository/sqlite-rule-store.js` | SQLite-backed repository with CRUD, activation, rollback, and audit. |
| `src/rules/forest-evaluator.js` | Evaluates a forest of trees using the existing `DecisionTreeEvaluator` and merges results. |
| `src/rules/loader.js` | Loads `latest` from DB when `RULE_STORE_DB_URL` is set; falls back to files. |
| `src/rules/schema.json` | JSON Schema now accepts both single-tree and forest packages. |
| `src/strategies/rule-based-strategy.js` | Uses `ForestEvaluator` when the loaded package is a forest. |
