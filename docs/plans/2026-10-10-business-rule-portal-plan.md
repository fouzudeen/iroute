# iRoute Business Rule Portal — Implementation Plan

> **For Hermes:** Do not delegate. This is a self-contained planning artifact for a new business-facing feature.

**Goal:** Give non-technical business users a low-cognitive-load web UI to author, preview, version, and publish rule packages and decision trees, replacing the current JSON-and-CLI workflow.

**Architecture:** Build a thin server-side admin layer and an HTML/JS single-page UI served by the existing Node HTTP server. Reuse the in-memory evaluator, validator, packager, and the new SQLite-backed forest store. Keep the rule engine itself untouched.

**Tech Stack:** Node 20 ESM, native `node:http`, vanilla HTML/JS/CSS (no new build tooling), `better-sqlite3`, existing Ajv/Pino stack, `iovalkey` for Valkey Streams/counters.

---

## Context & Constraints

The codebase is mid-way through a major change: `RuleLoader` has been extended to load a **forest** (network of decision trees) from an RDBMS-backed store while preserving file-based fallback. The new entities are:

- `DecisionTree` — keyed by `treeKey`, carries selector `criteria`.
- `RulePackage` — immutable semver version of rules for one tree.
- `RulePackageActivation` — active version per `(tree, environment, scope, scopeValue)`.
- `AuditLog` — all publish/activate/rollback events.

See:

- `docs/ARCHITECTURE_RDBMS_NETWORK.md`
- `src/repository/sqlite-rule-store.js`
- `src/store/schema.sql`
- `src/rules/forest-evaluator.js`
- `src/rules/loader.js`

The portal must:

1. Not require business users to understand JSON, the forest data model, or the publish/activate distinction.
2. Surface **only one active rule set per business context** at a time (e.g. "EU Cards in Production").
3. Make version history and rollback discoverable and one-click.
4. Provide a safe **preview mode** that simulates a payment context against any draft or published version without affecting live traffic.
5. Work on top of the current uncommitted RDBMS change set; do not duplicate the forest model.
6. **Prevent split-version fleets:** after a publish/activate, all live iroute instances must be on the same rule version before any of them serves traffic with it.

---

## UX Story: From the Business User's Point of View

> Alice logs into the iRoute Business Portal. She sees a dashboard of **Routing Policies** — not trees, not packages. Each policy card shows the business context it governs ("EU Card Payments", "US Wallet Payments", "Global High-Risk"), the currently live version, when it was published, and an "Edit" button.
>
> She opens "EU Card Payments". The rule list is shown as human-readable sentences: "If amount ≥ 500 AND country is in DE, FR, NL, BE, AT AND card brand is Visa or Mastercard, then route to PSP Premium EU first, PGSP EU Backup second." She clicks "Add Rule". A guided form asks: **When** (field, operator, value), **Then** (provider, weight, SLA). She can add multiple conditions and group them with AND/OR.
>
> When she saves, the portal creates a **draft** of the next version. She opens the simulator, fills a sample payment (amount, currency, country, card brand), and clicks "Preview Decision". The engine evaluates the draft and shows the ranked PSP list plus which rules matched. Satisfied, she clicks "Publish & Activate for Production". The portal starts a **rule change**: it writes the activation to SQLite, computes how many iroute instances are alive from their heartbeats, emits a `RULE_CHANGE_PREPARE` event to Valkey, and waits until every instance acknowledges it has staged the new package. Once the ready counter equals the expected instance count, the portal emits `RULE_CHANGE_COMMIT` and all instances swap atomically. The old version remains in history; a rollback button appears next to it.
>
> Bob, her teammate, opens the **History** tab and sees every version, who published it, and what changed (diff). He rolls back to 1.2.0 after a spike in declines. The same two-phase protocol runs. The activation is logged and live traffic switches together.

---

## Functional Requirements

### FR1 — Policy List Dashboard

- Endpoint `/portal/api/policies` returns a list of policies.
- A policy is derived from a `DecisionTree` plus its active package in one environment (default `production`).
- Each policy shows: human name, selector criteria summary, live version, published at, last editor, status badge (live/draft/rolled-back), and action links.

### FR2 — Rule Builder

- Visual editor for one policy's rules.
- Rules are ordered by priority (highest first).
- Each rule displays as a readable sentence generated from its condition and actions.
- Inline forms to add/edit:
  - rule id (auto-generated slug), description, priority;
  - condition builder with field picker, operator picker, and value input;
  - nested AND/OR groups;
  - provider list with id, type, weight, SLA.
- Validation runs against `src/rules/schema.json` before save.

### FR3 — Draft / Publish / Activate Lifecycle

- Saving a policy creates a new `RulePackage` row with `publishedAt = null` (draft).
- "Publish" sets `publishedAt` and immediately activates the package for the chosen environment and scope.
- "Activate" can promote an already-published older package.
- "Rollback" restores the previous published package.
- All actions write to `AuditLog`.

### FR4 — Simulator / Preview

- Endpoint `/portal/api/simulate` accepts a payment context and a target package version (or draft).
- Returns the routing decision and matched-rule explanation using the existing `ForestEvaluator` / `DecisionTreeEvaluator`.
- Does not require activation; reads the package directly from the store.

### FR5 — Version History & Diff

- Endpoint `/portal/api/policies/:treeKey/history` lists every published package for a tree.
- Show created by, published at, activation events, and a simple textual diff of rules JSON.

### FR6 — Portal UI Pages

- `GET /portal` — dashboard.
- `GET /portal/policy/:treeKey` — rule builder.
- `GET /portal/policy/:treeKey/history` — version history and rollback.
- `GET /portal/simulator` — standalone simulator (or inline panel inside builder).

### FR7 — Safety Guards

- Confirm dialog before activate/rollback.
- Warn when deleting a rule or lowering priority below default.
- Block publish if validation fails or if no default catch-all rule is present.

### FR8 — Audit Trail

- All create/update/publish/activate/rollback actions are recorded.
- UI shows the last 20 events per policy and a global recent-events feed.

---

## Non-Functional Requirements

- **No build step.** The UI is served as static HTML/JS/CSS from `src/portal/public` and uses vanilla JS with fetch.
- **One new runtime dependency:** `iovalkey` for Valkey Streams/counters.
- **Backward compatible.** Existing `/v1/route` and rule file workflow keep working.
- **Stateless admin endpoints.** Rule state lives in SQLite; coordination state lives in Valkey.
- **Security placeholders.** The portal endpoints should be annotated with TODOs for auth middleware; this plan does not implement auth.

## Tasks (engineer order)

1. Add Valkey client and coordination modules (`src/events/*`).
2. Extend store with helper methods.
3. Extend `RoutingEngine` for reload/staging.
4. Build portal API handlers.
5. Build portal UI pages.
6. Wire portal + coordination into `src/server.js`.
7. Write tests for portal and events.
8. Add seed script and docs.
9. Run `npm test`, `npm run lint`, manual server checks.

### FR9 — Coordinated Rule Change

- Publish/activate/rollback triggers a Valkey-backed two-phase commit.
- No instance swaps until every live instance has staged the new package.
- Admin status/force-commit/abort endpoints for operator override.

---

## UX Concepts to Reduce Cognitive Load

1. **Policy is the primary noun, not Tree/Package.** The UI never says "DecisionTree" or "RulePackage"; it says "Routing Policy" and "Version".
2. **Sentence-first rule display.** Every rule renders as: `When <conditions>, then route to <providers>.` JSON is hidden behind an "Advanced" toggle.
3. **Context selector at the top.** Criteria for matching a tree (region, payment method, etc.) are shown as tags, editable via a simple form.
4. **Live preview side panel.** The simulator is a collapsible side panel so users see the effect of edits without leaving the editor.
5. **Version timeline.** History is a vertical timeline with publish/activate/rollback events, not a table.
6. **Confidence badges.** "Default rule present", "Validation passed", "Draft unsaved", "Live now".
7. **Guided rule templates.** "High-value region", "Risk-based split", "Merchant whitelist", "Default catch-all" templates pre-fill common condition/provider patterns.

---

## Data Model Mapping (UI ⇄ Existing Store)

| UI Concept | Existing Store |
|------------|----------------|
| Routing Policy | `DecisionTree` + active `RulePackage` |
| Rules | `RulePackage.rules_json` |
| Selector / Scope | `DecisionTree.criteria_json` + activation `(scope, scopeValue)` |
| Version | `RulePackage.version` |
| Draft | `RulePackage` with `publishedAt IS NULL` |
| Live version | `RulePackageActivation` for `(env='production', scope='global')` |
| Publish & Activate | `publishPackage(..., { publish: true })` + `setActive(...)` + Valkey 2PC |
| Rollback | `rollback(...)` + Valkey 2PC |
| Author | `RulePackage.created_by` / `AuditLog.actor` |
| Coordinated change | Valkey Stream + counter + instance heartbeats |

---

## Coordinated Rule Change Protocol (counter-based 2PC)

### Valkey data structures

| Key / Stream | Type | Purpose |
|---|---|---|
| `iroute:rule:changes` | Valkey Stream | Ordered log of every rule change event. |
| `iroute:rule:change:{changeId}` | Hash | Change metadata: `treeKey`, `environment`, `scope`, `scopeValue`, `version`, `packageId`, `checksum`, `expectedInstances`, `timeoutAt`. |
| `iroute:rule:ready:{changeId}` | Counter | How many instances have staged and validated the new package. |
| `iroute:rule:commit:{changeId}` | String | `PENDING` → `COMMITTED` or `ABORTED`. |
| `iroute:rule:instance:{instanceId}` | String with TTL | Heartbeat registry used to count live instances. |
| `iroute:rule:writer-lock:{env}:{scope}` | String with TTL | Portal lock to serialize writes for one environment/scope. |

### Event schema

Prepare event (appended by portal):

```json
{
  "eventType": "RULE_CHANGE_PREPARE",
  "changeId": "<uuid>",
  "treeKey": "eu-cards",
  "environment": "production",
  "scope": "global",
  "scopeValue": "",
  "version": "1.3.0",
  "packageId": "<uuid>",
  "checksum": "<sha256>",
  "expectedInstances": 6,
  "timeoutMs": 30000,
  "actor": "alice@example.com",
  "timestamp": "2026-10-10T12:34:56Z"
}
```

Commit event (appended by portal when ready counter reaches expected):

```json
{
  "eventType": "RULE_CHANGE_COMMIT",
  "changeId": "<uuid>"
}
```

Abort event (appended on timeout or operator action):

```json
{
  "eventType": "RULE_CHANGE_ABORT",
  "changeId": "<uuid>",
  "reason": "timeout"
}
```

### Writer lock lifetime

The writer lock `iroute:rule:writer-lock:{env}:{scope}` MUST be held for the **entire** rule-change lifecycle, not just the `prepareChange` step. It is acquired before the prepare event is emitted and released only after the change is committed or aborted. This prevents a second publisher from interleaving a new change while the fleet is still staging the previous one. The current implementation stores the lock reference in the coordinator process and releases it in `commit()`/`abort()`.

> ⚠️ **Known concern:** The lock is held in-process by the coordinator. If the portal process crashes between `prepareChange` and `commit`/`abort`, the lock remains in Valkey until its TTL expires (default 10s). During that window, the environment/scope cannot publish. Future work should add a heartbeat-based `recover()` or explicit `force-release` endpoint for operators, and consider Redlock/Raft semantics if Valkey is clustered.

### Flow

1. **Portal publish/activate/rollback**
   - Acquire writer lock `iroute:rule:writer-lock:{env}:{scope}` (NX, TTL 10s).
   - Update SQLite: insert package, set activation, write audit log.
   - Read live instances from heartbeat registry to compute `expectedInstances`.
   - Create `change:{id}` hash, set `ready:{id}` to 0, `commit:{id}` to `PENDING`.
   - Append `RULE_CHANGE_PREPARE` to `iroute:rule:changes`.
   - Start polling `ready:{id}`.

2. **Each iroute instance consumes the prepare**
   - Load the package version described by the event from SQLite/store.
   - Validate with `RuleValidator`.
   - Stage the validated package in `engine._pendingRulePackage`.
   - `INCR iroute:rule:ready:{changeId}`.
   - Continue consuming the stream.

3. **Portal commits**
   - When `ready:{id} >= expectedInstances`, set `commit:{id} = COMMITTED` and append `RULE_CHANGE_COMMIT`.
   - If timeout elapses first, append `RULE_CHANGE_ABORT`.

4. **Instances apply commit/abort**
   - On `COMMIT`: atomically swap `engine._rulePackage` and the `RuleBasedStrategy` in the registry; clear staging; update local `lastAppliedChangeId`.
   - On `ABORT`: discard staging.

5. **Health/readiness gate**
   - `/health/ready` returns 503 if the instance has a staged but uncommitted change, or if it is missing a `COMMIT` event it has already seen a `PREPARE` for.

### CAP trade-off

The protocol is CP-ish for the rule change itself: if an instance is partitioned, commit is blocked. Operational workarounds:

- Instance heartbeats expire after a TTL; the portal recomputes `expectedInstances` and can lower the quorum.
- Admin endpoints `POST /portal/api/admin/changes/:changeId/force-commit` and `/abort` let an operator break the logjam.
- During maintenance windows, operators can reduce the expected instance count via `RULE_CHANGE_EXPECTED_INSTANCES` env var.

---

## API Surface

All routes are prefixed `/portal/api`. They return JSON.

```
GET    /portal/api/policies
GET    /portal/api/policies/:treeKey
POST   /portal/api/policies
PUT    /portal/api/policies/:treeKey
POST   /portal/api/policies/:treeKey/draft
POST   /portal/api/policies/:treeKey/publish
POST   /portal/api/policies/:treeKey/activate
POST   /portal/api/policies/:treeKey/rollback
GET    /portal/api/policies/:treeKey/history
POST   /portal/api/simulate
GET    /portal/api/audit
GET    /portal/api/admin/changes/:changeId/status
POST   /portal/api/admin/changes/:changeId/force-commit
POST   /portal/api/admin/changes/:changeId/abort
```

Each endpoint delegates to `SqliteRuleStore` and the existing evaluator/validator. See the task list below for request/response shapes.

---

## Files to Create / Modify

### New files

- `src/portal/portal-server.js` — Express-style router mounted inside `src/server.js`.
- `src/portal/handlers/policies.js` — API handlers for policies, versions, lifecycle.
- `src/portal/handlers/simulate.js` — preview endpoint.
- `src/portal/handlers/audit.js` — audit feed.
- `src/portal/handlers/admin-changes.js` — change status, force-commit, abort.
- `src/portal/formatters/rule-sentence.js` — convert condition tree to readable sentence.
- `src/events/valkey-client.js` — shared `iovalkey` wrapper.
- `src/events/change-coordinator.js` — portal-side 2PC coordinator.
- `src/events/change-consumer.js` — iroute-side stream consumer.
- `src/events/instance-heartbeat.js` — instance heartbeat publisher.
- `src/events/distributed-lock.js` — Valkey lock helper.
- `src/portal/public/index.html` — dashboard.
- `src/portal/public/policy.html` — rule builder + simulator.
- `src/portal/public/history.html` — version timeline.
- `src/portal/public/app.js` — shared JS utilities.
- `src/portal/public/styles.css` — minimal accessible styling.
- `tests/portal/policies.test.js` — API contract tests.
- `tests/portal/simulate.test.js` — simulator tests.
- `tests/portal/rule-sentence.test.js` — formatter tests.
- `tests/events/change-coordinator.test.js`
- `tests/events/change-consumer.test.js`
- `scripts/seed-portal.js`

### Modified files

- `src/server.js` — mount portal routes/static files; start heartbeat + consumer; update readiness.
- `src/repository/sqlite-rule-store.js` — add `getPackageById`, `listDrafts`, `deletePackage`, `setPackagePublished`, `updateTree`.
- `src/engine/routing-engine.js` — add `reload()`, `_pendingRulePackage`, `lastAppliedChangeId`, expose readiness state.
- `src/rules/loader.js` — expose `loadActiveForScope(env, scope, scopeValue)`.
- `package.json` — add `iovalkey` and `seed:portal` script.
- `README.md`
- `docs/ARCHITECTURE_RDBMS_NETWORK.md`

---

## Tasks

### Task 1: Create portal route scaffold

**Objective:** Add `/portal/api` routes to `src/server.js` and a dedicated portal router module.

**Files:**
- Create: `src/portal/portal-server.js`
- Modify: `src/server.js`

**Step 1:** Create `src/portal/portal-server.js`

```javascript
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { policiesHandler } from './handlers/policies.js';
import { simulateHandler } from './handlers/simulate.js';
import { auditHandler } from './handlers/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
  });
}

export function portalRouter(store, options = {}) {
  return async function handlePortal(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Static assets
    if (req.method === 'GET' && pathname.startsWith('/portal/public/')) {
      const file = pathname.replace('/portal/public/', '');
      const path = resolve(PUBLIC_DIR, file);
      // Security: prevent directory traversal by checking the resolved path stays inside PUBLIC_DIR
      if (!path.startsWith(PUBLIC_DIR + '/') && path !== PUBLIC_DIR) {
        return sendJson(res, 403, { code: 'FORBIDDEN', message: 'Invalid path' });
      }
      try {
        const stream = createReadStream(path);
        res.writeHead(200);
        stream.pipe(res);
      } catch (err) {
        sendJson(res, 404, { code: 'NOT_FOUND', message: err.message });
      }
      return;
    }

    // API routes
    if (pathname === '/portal/api/policies' && req.method === 'GET') {
      return policiesHandler.list(store, { environment: options.environment }, sendJson);
    }
    if (pathname === '/portal/api/policies' && req.method === 'POST') {
      const body = await readBody(req);
      return policiesHandler.create(store, body, sendJson);
    }
    if (pathname === '/portal/api/simulate' && req.method === 'POST') {
      const body = await readBody(req);
      return simulateHandler(store, body, sendJson);
    }
    if (pathname === '/portal/api/audit' && req.method === 'GET') {
      return auditHandler(store, url.searchParams, sendJson);
    }
    if (pathname.startsWith('/portal/api/policies/')) {
      const rest = pathname.replace('/portal/api/policies/', '');
      const [treeKey, action] = rest.split('/');
      if (!action) {
        if (req.method === 'GET') return policiesHandler.get(store, treeKey, sendJson);
        if (req.method === 'PUT') {
          const body = await readBody(req);
          return policiesHandler.update(store, treeKey, body, sendJson);
        }
      }
      if (action === 'draft' && req.method === 'POST') {
        const body = await readBody(req);
        return policiesHandler.saveDraft(store, treeKey, body, sendJson);
      }
      if (action === 'publish' && req.method === 'POST') {
        const body = await readBody(req);
        return policiesHandler.publish(store, treeKey, body, sendJson);
      }
      if (action === 'activate' && req.method === 'POST') {
        const body = await readBody(req);
        return policiesHandler.activate(store, treeKey, body, sendJson);
      }
      if (action === 'rollback' && req.method === 'POST') {
        return policiesHandler.rollback(store, treeKey, sendJson);
      }
      if (action === 'history' && req.method === 'GET') {
        return policiesHandler.history(store, treeKey, sendJson);
      }
    }

    return sendJson(res, 404, { code: 'NOT_FOUND', message: `Unknown portal route ${req.method} ${pathname}` });
  };
}
```

**Step 2:** Mount router in `src/server.js`

After `engine` is initialized, instantiate `portalRouter(engine.loader.store, { environment: process.env.RULE_ENVIRONMENT || 'production' })` and add an early branch in the request handler:

```javascript
if (url.pathname.startsWith('/portal')) {
  return portalRouter(...)(req, res);
}
```

(Exact wiring depends on how `RuleLoader` exposes its store; we may need to add a getter.)

**Step 3:** Verify the server starts without error.

Run: `npm test`  
Expected: all existing tests still pass.

**Step 4:** Commit.

```bash
git add src/portal/portal-server.js src/server.js
git commit -m "feat(portal): scaffold portal router and API mount points"
```

---

### Task 2: Add policy list and detail API

**Objective:** Implement `/portal/api/policies` and `/portal/api/policies/:treeKey`.

**Files:**
- Create: `src/portal/handlers/policies.js`
- Modify: `src/repository/sqlite-rule-store.js`

**Step 1:** Add missing store helpers in `src/repository/sqlite-rule-store.js`.

Add after `getTreeByKey`:

```javascript
getPackageById(id) {
  const row = this.db.prepare('SELECT * FROM rule_packages WHERE id = ?').get(id);
  return row ? this._hydratePackage(row) : null;
}

listDrafts(treeId) {
  const rows = this.db.prepare(
    'SELECT * FROM rule_packages WHERE decision_tree_id = ? AND published_at IS NULL ORDER BY created_at DESC'
  ).all(treeId);
  return rows.map(r => this._hydratePackage(r));
}

deletePackage(id) {
  this.db.prepare('DELETE FROM rule_packages WHERE id = ?').run(id);
}
```

**Step 2:** Create `src/portal/handlers/policies.js`.

```javascript
import { RoutingError } from '../../errors/errors.js';
import { RuleValidator } from '../../rules/validator.js';

const validator = new RuleValidator();
const DEFAULT_ENV = 'production';

function policySummary(tree, store, env) {
  const active = store.getActivePackage(tree.id, env, 'global');
  const drafts = store.listDrafts(tree.id);
  const versions = store.listPackages(tree.id);
  return {
    treeKey: tree.treeKey,
    name: tree.name,
    description: tree.description,
    criteria: tree.criteria,
    liveVersion: active ? { version: active.version, publishedAt: active.publishedAt, createdBy: active.createdBy } : null,
    draftCount: drafts.length,
    versionCount: versions.length,
    updatedAt: tree.updatedAt
  };
}

export const policiesHandler = {
  list(store, { environment = DEFAULT_ENV }, send) {
    if (!store) return send(503, { code: 'RULE_STORE_UNAVAILABLE', message: 'Portal requires RULE_STORE_DB_URL' });
    const trees = store.listTrees();
    return send(200, { policies: trees.map(t => policySummary(t, store, environment)) });
  },

  get(store, treeKey, send) {
    const tree = store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    return send(200, { policy: policySummary(tree, store, DEFAULT_ENV) });
  },

  create(store, body, send) {
    const { treeKey, name, description = '', criteria = {} } = body;
    if (!treeKey || !name) {
      return send(400, { code: 'INVALID_REQUEST', message: 'treeKey and name are required' });
    }
    const tree = store.createTree({ treeKey, name, description, criteria });
    return send(201, { policy: policySummary(tree, store, DEFAULT_ENV) });
  },

  update(store, treeKey, body, send) {
    const tree = store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    // Name/description/criteria updates only; rules live in packages.
    // For now, criteria can be updated by republishing; this handler is a placeholder.
    return send(200, { policy: policySummary(tree, store, DEFAULT_ENV) });
  }
};
```

**Step 3:** Add tests.

Create `tests/portal/policies.test.js`:

```javascript
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { policiesHandler } from '../../src/portal/handlers/policies.js';

let store;

before(() => { store = new SqliteRuleStore({ url: ':memory:' }); });
after(() => { store.close(); });

test('list policies returns empty array', () => {
  policiesHandler.list(store, { environment: 'production' }, (status, body) => {
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.policies, []);
  });
});

test('create policy then list', () => {
  policiesHandler.create(store, { treeKey: 'eu-cards', name: 'EU Cards', criteria: { region: 'EU' } }, (status, body) => {
    assert.strictEqual(status, 201);
    assert.strictEqual(body.policy.treeKey, 'eu-cards');
  });
  policiesHandler.list(store, { environment: 'production' }, (status, body) => {
    assert.strictEqual(status, 200);
    assert.strictEqual(body.policies.length, 1);
  });
});
```

**Step 4:** Run tests.

```bash
npm test
```

Expected: existing + new tests pass.

**Step 5:** Commit.

```bash
git add src/portal/handlers/policies.js src/repository/sqlite-rule-store.js tests/portal/policies.test.js
git commit -m "feat(portal): policy list and create API"
```

---

### Task 3: Implement draft, publish, activate, rollback, history

**Objective:** Complete the rule-package lifecycle endpoints.

**Files:**
- Modify: `src/portal/handlers/policies.js`
- Modify: `src/repository/sqlite-rule-store.js` (add `updateTreeCriteria` if needed)

**Step 1:** Extend policies handler.

Add inside `policiesHandler`:

```javascript
saveDraft(store, treeKey, body, send) {
  const tree = store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });

  const packageShape = {
    version: body.version || this._nextDraftVersion(store, tree.id),
    createdAt: new Date().toISOString(),
    description: body.description || '',
    rules: body.rules || []
  };

  const valid = validator.validate(packageShape);
  if (!valid) {
    return send(422, { code: 'VALIDATION_ERROR', errors: validator.errors });
  }

  const pkg = store.publishPackage(tree.id, packageShape.version, packageShape, {
    description: body.description,
    publish: false,
    createdBy: body.createdBy || 'portal'
  });
  return send(201, { version: pkg.version, checksum: pkg.checksum });
},

publish(store, treeKey, body, send) {
  const tree = store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
  const version = body.version;
  const env = body.environment || DEFAULT_ENV;
  const scope = body.scope || 'global';
  const scopeValue = body.scopeValue || '';
  const actor = body.createdBy || 'portal';

  const pkg = store.getPackage(tree.id, version);
  if (!pkg) return send(404, { code: 'VERSION_NOT_FOUND', message: version });

  // If currently a draft, mark published.
  if (!pkg.publishedAt) {
    // We need a store method to set published_at; add it or republish.
  }

  const active = store.setActive(tree.id, version, env, scope, scopeValue, actor);
  return send(200, { policy: policySummary(tree, store, env), activated: active.version });
},

activate(store, treeKey, body, send) {
  return this.publish(store, treeKey, body, send);
},

rollback(store, treeKey, send) {
  const tree = store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
  const pkg = store.rollback(tree.id, DEFAULT_ENV, 'global');
  if (!pkg) return send(422, { code: 'ROLLBACK_FAILED', message: 'No previous version' });
  return send(200, { policy: policySummary(tree, store, DEFAULT_ENV), rolledBackTo: pkg.version });
},

history(store, treeKey, send) {
  const tree = store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
  const versions = store.listPackages(tree.id);
  return send(200, {
    policy: { treeKey: tree.treeKey, name: tree.name },
    versions: versions.map(v => ({
      version: v.version,
      description: v.description,
      publishedAt: v.publishedAt,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      isActive: !!store.getActivePackage(tree.id, DEFAULT_ENV, 'global')?.version === v.version
    }))
  });
}
```

**Step 2:** Add `setPackagePublished(id)` helper in `sqlite-rule-store.js`.

```javascript
setPackagePublished(id) {
  this.db.prepare("UPDATE rule_packages SET published_at = datetime('now') WHERE id = ?").run(id);
  return this.getPackageById(id);
}
```

Use it in the publish handler.

**Step 3:** Add `updateTreeCriteria(treeId, criteria)` if the UI needs to edit criteria.

```javascript
updateTree(treeId, { name, description, criteria }) {
  this.db.prepare(
    `UPDATE decision_trees
     SET name = COALESCE(?, name),
         description = COALESCE(?, description),
         criteria_json = COALESCE(?, criteria_json),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, description, criteria ? JSON.stringify(criteria) : undefined, treeId);
  return this.getTreeById(treeId);
}
```

**Step 4:** Add tests in `tests/portal/policies.test.js` for publish/rollback/history.

**Step 5:** Run tests and commit.

```bash
npm test
git add src/portal/handlers/policies.js src/repository/sqlite-rule-store.js tests/portal/policies.test.js
git commit -m "feat(portal): publish, activate, rollback and history endpoints"
```

---

### Task 4: Build the simulator endpoint

**Objective:** Allow preview of any package version against a sample context.

**Files:**
- Create: `src/portal/handlers/simulate.js`
- Create: `tests/portal/simulate.test.js`

**Step 1:** Implement `simulate.js`.

```javascript
import { DecisionTreeEvaluator } from '../../rules/evaluator.js';
import { ForestEvaluator } from '../../rules/forest-evaluator.js';
import { ContextNormalizer } from '../../context/context.js';

const normalizer = new ContextNormalizer();

export function simulateHandler(store, body, send) {
  const { treeKey, version, context } = body;
  if (!treeKey || !version) {
    return send(400, { code: 'INVALID_REQUEST', message: 'treeKey and version are required' });
  }

  const tree = store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });

  const pkg = store.getPackage(tree.id, version);
  if (!pkg) return send(404, { code: 'VERSION_NOT_FOUND', message: version });

  const normalized = normalizer.normalize({
    requestId: 'portal-sim-' + Date.now(),
    ...context
  });

  const evaluator = new DecisionTreeEvaluator({ version: pkg.version, rules: pkg.rules.rules });
  const result = evaluator.evaluate(normalized);

  return send(200, {
    context: normalized,
    version: pkg.version,
    matches: result.matches,
    matchedRules: result.appliedRules,
    candidates: result.prioritizedProviders.map((p, i) => ({
      priority: i + 1,
      pspId: p.type === 'psp' ? p.id : null,
      pgspId: p.type === 'pgsp' ? p.id : null,
      score: p.score,
      reasons: [p.ruleId],
      estimatedLatencyMs: p.slaMs || null
    }))
  });
}
```

**Step 2:** Add tests.

```javascript
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRuleStore } from '../../src/repository/sqlite-rule-store.js';
import { simulateHandler } from '../../src/portal/handlers/simulate.js';

let store;
before(() => { store = new SqliteRuleStore({ url: ':memory:' }); });
after(() => { store.close(); });

test('simulate returns candidates for matching rule', () => {
  const tree = store.createTree({ treeKey: 'sim-tree', name: 'Sim', criteria: {} });
  store.publishPackage(tree.id, '1.0.0', {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    rules: [
      { id: 'r1', priority: 10, condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-eu', type: 'psp', weight: 100 }] } }
    ]
  }, { publish: true });

  simulateHandler(store, { treeKey: 'sim-tree', version: '1.0.0', context: { amount: 100, currency: 'eur' } }, (status, body) => {
    assert.strictEqual(status, 200);
    assert.strictEqual(body.matches, 1);
    assert.strictEqual(body.candidates[0].pspId, 'psp-eu');
  });
});
```

**Step 3:** Run tests and commit.

```bash
npm test
git add src/portal/handlers/simulate.js tests/portal/simulate.test.js
git commit -m "feat(portal): simulator endpoint with tests"
```

---

### Task 5: Human-readable rule sentence formatter

**Objective:** Convert a condition tree to a sentence.

**Files:**
- Create: `src/portal/formatters/rule-sentence.js`
- Create: `tests/portal/rule-sentence.test.js`

**Step 1:** Implement formatter.

```javascript
const OP_WORDS = {
  eq: 'is',
  ne: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  notIn: 'is not one of',
  regex: 'matches'
};

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function formatCondition(condition) {
  if (condition.operator === 'and') {
    return condition.conditions.map(formatCondition).join(' AND ');
  }
  if (condition.operator === 'or') {
    return `(${condition.conditions.map(formatCondition).join(' OR ')})`;
  }
  if (condition.operator === 'not') {
    return `NOT (${condition.conditions.map(formatCondition).join(' AND ')})`;
  }
  const op = OP_WORDS[condition.operator] || condition.operator;
  return `${condition.field} ${op} ${formatValue(condition.value)}`;
}

export function ruleSentence(rule) {
  const when = formatCondition(rule.condition);
  const providers = (rule.actions.providers || []).map(p => `${p.id}${p.weight ? ` (${p.weight})` : ''}`).join(', ');
  const fallback = rule.actions.fallback ? `; fallback ${rule.actions.fallback.id}` : '';
  return `When ${when}, route to ${providers}${fallback}.`;
}
```

**Step 2:** Add tests.

**Step 3:** Commit.

```bash
npm test
git add src/portal/formatters/rule-sentence.js tests/portal/rule-sentence.test.js
git commit -m "feat(portal): human-readable rule sentence formatter"
```

---

### Task 6: Build dashboard UI

**Objective:** Static HTML dashboard listing policies.

**Files:**
- Create: `src/portal/public/index.html`
- Create: `src/portal/public/app.js`
- Create: `src/portal/public/styles.css`

**Step 1:** Create `styles.css`.

Minimal, no frameworks:

```css
:root { --bg: #f6f8fa; --card: #fff; --primary: #2563eb; --danger: #dc2626; --muted: #6b7280; }
body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); margin: 0; padding: 2rem; color: #111; }
.container { max-width: 960px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
.card { background: var(--card); border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 1rem; }
.badge { display: inline-block; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 999px; background: #e5e7eb; color: #374151; }
.badge.live { background: #d1fae5; color: #065f46; }
.badge.draft { background: #fef3c7; color: #92400e; }
.btn { border: none; padding: 0.5rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.875rem; }
.btn-primary { background: var(--primary); color: #fff; }
.btn-danger { background: var(--danger); color: #fff; }
```

**Step 2:** Create `app.js` with shared helpers.

```javascript
const API = '/portal/api';

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return node;
}
```

**Step 3:** Create `index.html`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iRoute Business Portal</title>
  <link rel="stylesheet" href="/portal/public/styles.css">
</head>
<body>
  <div class="container">
    <header>
      <h1>Routing Policies</h1>
      <button class="btn btn-primary" id="new-policy">+ New Policy</button>
    </header>
    <div id="policies"></div>
  </div>
  <script type="module" src="/portal/public/app.js"></script>
  <script type="module">
    import { API } from '/portal/public/app.js';
    const container = document.getElementById('policies');
    async function load() {
      const { policies } = await fetch(`${API}/policies`).then(r => r.json());
      container.innerHTML = '';
      if (!policies.length) {
        container.appendChild(el('div', { class: 'card' }, 'No policies yet. Create one to get started.'));
        return;
      }
      for (const p of policies) {
        const status = p.liveVersion ? 'live' : 'draft';
        const card = el('div', { class: 'card' },
          el('div', { style: 'display:flex; justify-content:space-between' },
            el('h3', {}, p.name),
            el('span', { class: `badge ${status}` }, status.toUpperCase())
          ),
          el('p', { style: 'color:var(--muted)' }, p.description || 'No description'),
          el('p', {}, `Live: ${p.liveVersion ? `${p.liveVersion.version} by ${p.liveVersion.createdBy || 'unknown'}` : 'none'}`),
          el('a', { href: `/portal/policy/${p.treeKey}`, class: 'btn btn-primary' }, 'Edit'),
          ' ',
          el('a', { href: `/portal/policy/${p.treeKey}/history`, class: 'btn' }, 'History')
        );
        container.appendChild(card);
      }
    }
    load();
  </script>
</body>
</html>
```

**Step 4:** Serve and visually sanity check.

Run `npm start`, open `http://localhost:3000/portal`. (No automated test for UI styling; just verify no console errors.)

**Step 5:** Commit.

```bash
git add src/portal/public/index.html src/portal/public/app.js src/portal/public/styles.css
git commit -m "feat(portal): dashboard UI"
```

---

### Task 7: Build rule builder UI

**Objective:** Page to add/edit rules and preview decisions inline.

**Files:**
- Create: `src/portal/public/policy.html`

**Step 1:** Build form-heavy HTML page.

Key elements:

- Header with policy name and status badges.
- "Add Rule" button opening a modal/form with:
  - Rule description
  - Priority number
  - Condition builder (rows of field/operator/value, plus AND/OR grouping)
  - Provider list (id, type, weight, SLA)
- List of existing rules rendered via `ruleSentence`.
- Side panel simulator: amount, currency, country, card brand, payment method; "Preview" button; results table.
- "Save Draft" and "Publish" buttons.

Keep it functional but minimal. Use `fetch` to:

- `GET /portal/api/policies/:treeKey`
- `GET /portal/api/policies/:treeKey/history`
- `POST /portal/api/policies/:treeKey/draft`
- `POST /portal/api/policies/:treeKey/publish`
- `POST /portal/api/simulate`

**Step 2:** Add route in `portal-server.js` for `/portal/policy/:treeKey` and `/portal/policy/:treeKey/history` to serve the same HTML files.

**Step 3:** Sanity check in browser.

**Step 4:** Commit.

```bash
git add src/portal/public/policy.html src/portal/portal-server.js
git commit -m "feat(portal): rule builder with inline simulator"
```

---

### Task 8: Build history and rollback UI

**Objective:** Timeline page for version history.

**Files:**
- Create: `src/portal/public/history.html`

**Step 1:** Build `history.html`.

Shows:

- Policy name.
- Vertical timeline of versions with publish date, author, active badge.
- "Rollback" button for non-active published versions (confirm dialog).
- Diff viewer showing JSON diff between selected version and previous.

**Step 2:** Add to portal-server routing.

**Step 3:** Sanity check.

**Step 4:** Commit.

```bash
git add src/portal/public/history.html src/portal/portal-server.js
git commit -m "feat(portal): version history and rollback UI"
```

---

### Task 9: Wire portal router into main server

**Objective:** Make sure `src/server.js` mounts the portal and passes the store reference.

**Step 1:** In `src/server.js`, after `initEngine`, expose the store.

```javascript
const store = engine.loader.store;
const portal = portalRouter(store, { environment: process.env.RULE_ENVIRONMENT || 'production' });
```

If `engine.loader.store` is not public, add a getter to `RuleLoader`:

```javascript
get store() { return this.store; }
```

**Step 2:** Add dispatch branch:

```javascript
if (url.pathname.startsWith('/portal')) {
  return portal(req, res);
}
```

**Step 3:** Verify `/portal` and `/v1/route` both work.

Run:

```bash
npm test
npm start &
sleep 2
curl -s http://localhost:3000/portal/api/policies | head -c 200
kill %1
```

Expected: JSON policies array.

**Step 4:** Commit.

```bash
git add src/server.js src/rules/loader.js
git commit -m "feat(portal): integrate portal router into main server"
```

---

### Task 10: Seed data and documentation

**Objective:** Make it easy for a developer to see the portal working locally.

**Files:**
- Create: `scripts/seed-portal.js`
- Modify: `README.md`
- Modify: `docs/RULE_AUTHORING.md`

**Step 1:** Create seed script.

Populates the SQLite store with two sample trees and a published version each.

```javascript
import { SqliteRuleStore } from '../src/repository/sqlite-rule-store.js';
const store = new SqliteRuleStore({ url: process.env.RULE_STORE_DB_URL || './rules/portal-rules.db' });
const eu = store.createTree({ treeKey: 'eu-cards', name: 'EU Card Payments', criteria: { region: 'EU', paymentMethod: 'card' } });
store.publishPackage(eu.id, '1.0.0', {
  version: '1.0.0',
  createdAt: new Date().toISOString(),
  description: 'Initial EU card rules',
  rules: [
    { id: 'default-eu', priority: 0, description: 'Default EU route', condition: { operator: 'eq', field: 'currency', value: 'EUR' }, actions: { providers: [{ id: 'psp-standard', type: 'psp', weight: 100 }] } }
  ]
}, { publish: true, createdBy: 'seed' });
store.setActive(eu.id, '1.0.0', 'production', 'global');
console.log('Seeded portal database.');
store.close();
```

**Step 2:** Add script to `package.json`:

```json
"seed:portal": "node scripts/seed-portal.js"
```

**Step 3:** Update README with portal section.

Add:

```markdown
## Business Portal

A web UI for business users to manage routing policies is available at `/portal`.

```bash
npm run seed:portal
RULE_STORE_DB_URL=./rules/portal-rules.db npm start
```

Open http://localhost:3000/portal.
```

**Step 4:** Commit.

```bash
git add scripts/seed-portal.js package.json README.md
git commit -m "feat(portal): seed script and docs"
```

---

## Verification Checklist

- [ ] `npm test` passes (existing + new portal tests).
- [ ] `npm run lint` passes.
- [ ] `npm start` serves `/portal` and `/portal/api/policies`.
- [ ] Dashboard lists policies.
- [ ] Rule builder can save a draft.
- [ ] Simulator returns expected candidates.
- [ ] Publish activates a version.
- [ ] Rollback restores previous version.
- [ ] Two-phase commit: all instances stage before any swaps.
- [ ] `/health/ready` reflects pending changes.
- [ ] Audit log records all lifecycle actions.
- [ ] Existing `/v1/route` still works with file-based fallback.

---

## Open Questions / Future Work

1. **Authentication / authorization.** Portal endpoints are currently open. Add middleware once the project's auth strategy is known.
2. **Multi-environment support.** Default is `production`. Add environment selector when needed.
3. **Scope beyond global.** The plan only implements `scope='global'` activations. Merchant/region scopes can be added later in the UI.
4. **Real-time collaboration.** Concurrent edits could overwrite drafts. Add optimistic locking or per-user drafts if required.
5. **Visual rule graph.** The sentence formatter is the first UX layer. A future iteration can render a node graph.
6. **Production Valkey cluster topology.** Single-node today; Redlock or Raft-based lock if true multi-master coordination is needed.
7. **Writer-lock recovery.** The lock is held in-process by the coordinator. A crash leaves it in Valkey until TTL expiry. Add a `recover()` or operator `force-release` endpoint later.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Store not configured (file-only deployments) | Portal returns `503 RULE_STORE_UNAVAILABLE`; main routing still works. |
| Drafts accumulate in DB | Add periodic cleanup or hard-limit to 10 drafts per tree. |
| Large rule sets slow simulator | Evaluator is in-memory and fast; if needed, add request timeout and client-side debounce. |
| UI lacks auth | Document as known gap; all mutating endpoints include audit logging. |
