# iRoute Business Rule Portal — Test Strategy

> **Scope:** Validate the Business Rule Portal API and the counter-based two-phase rule-change propagation system described in `docs/plans/2026-10-10-business-rule-portal-plan.md`.

## 1. Approach

- **Runner:** Node 20 native `node --test`.
- **No new test dependencies** unless absolutely required. Valkey is mocked with a lightweight in-memory fake that implements Streams, Hashes, Strings, Counters, TTL locks, and heartbeats.
- **Layering:**
  1. Unit tests for each new module (`tests/events/*.test.js`, `tests/portal/*.test.js`).
  2. Integration tests for the 2PC flow across mocked instances (`tests/events/change-integration.test.js`).
  3. Contract tests that call the HTTP portal router and assert status/body shape (`tests/portal/portal-contract.test.js`).
  4. Manual UI smoke checklist (this document, section 7).
- **Data:** Tests use `SqliteRuleStore({ url: ':memory:' })` and clean up with `store.close()`.
- **Parallel safety:** Tests that bind an HTTP port use dynamic `PORT=0` and close servers in `after`.

## 2. Unit Tests — Portal Handlers

### `tests/portal/policies.test.js`

| Test | Description |
|------|-------------|
| `list returns empty policies array` | `GET /portal/api/policies` returns `{ policies: [] }` when no trees exist. |
| `list returns policy summary` | After creating a tree, the summary has `treeKey`, `name`, `liveVersion`, `draftCount`, `versionCount`. |
| `create requires treeKey and name` | Missing fields → 400 with `INVALID_REQUEST`. |
| `create policy stores tree` | 201, persisted, audit log written. |
| `get policy returns 404 for unknown treeKey` | `POLICY_NOT_FOUND`. |
| `get policy returns summary` | Matches created tree. |
| `update policy metadata` | Name/description/criteria updates reflected. |
| `saveDraft stores unpublished package` | `publishedAt` is null, checksum computed. |
| `saveDraft rejects invalid rules` | `VALIDATION_ERROR` 422. |
| `publish activates and records audit` | Active version set, audit has `PUBLISH` + `ACTIVATE`. |
| `activate promotes older published version` | Activation switches without creating a new package. |
| `rollback restores previous version` | Audit has `ROLLBACK`; active version changes. |
| `rollback fails when no previous version` | `ROLLBACK_FAILED` 422. |
| `history lists versions in order` | Includes active flag and author. |

### `tests/portal/simulate.test.js`

| Test | Description |
|------|-------------|
| `simulate requires treeKey and version` | 400 `INVALID_REQUEST`. |
| `simulate returns 404 for unknown policy` | `POLICY_NOT_FOUND`. |
| `simulate returns 404 for unknown version` | `VERSION_NOT_FOUND`. |
| `simulate returns matched providers` | Correct candidates, scores, rule IDs for matching context. |
| `simulate returns empty candidates when no match` | Default rule produces a candidate or `matches: 0`. |
| `simulate normalizes context` | Currency, country, paymentMethod are upper/lower-cased. |

### `tests/portal/rule-sentence.test.js`

| Test | Description |
|------|-------------|
| `formats simple equality` | `When currency is EUR, route to psp-eu.` |
| `formats AND/OR groups` | Parentheses and joiners correct. |
| `formats provider list with weights` | `(100)` suffix. |
| `formats fallback` | `; fallback psp-fallback`. |

### `tests/portal/audit.test.js`

| Test | Description |
|------|-------------|
| `audit feed returns recent events` | After create/publish, entries returned newest-first. |
| `audit feed filters by treeKey` | Only events for the requested policy. |
| `audit feed limits results` | Default limit (20) respected. |

### `tests/portal/admin-changes.test.js`

| Test | Description |
|------|-------------|
| `status returns change metadata` | treeKey, expectedInstances, ready count, commit state. |
| `force-commit sets commit state` | `COMMITTED`, stream event appended. |
| `abort sets abort state` | `ABORTED`, stream event appended, reason recorded. |

## 3. Unit Tests — Event Modules

### `tests/events/valkey-client.test.js`

| Test | Description |
|------|-------------|
| `connects to fake valkey` | In-memory client accepts commands. |
| `xadd appends to stream` | Returns message id; stream length increments. |
| `xread reads stream entries` | Returns appended events by stream name. |
| `hset/hgetall stores hashes` | Round-trip. |
| `set/get/incr counters` | Numeric semantics. |
| `set nx with ttl` | Lock acquire/release semantics. |
| `del removes key` | Used for lock release. |

### `tests/events/distributed-lock.test.js`

| Test | Description |
|------|-------------|
| `acquire returns true when lock free` | NX, TTL. |
| `acquire returns false when lock held` | Same owner remains locked. |
| `release deletes lock` | Subsequent acquire succeeds. |
| `extend refreshes ttl` | TTL value changes. |

### `tests/events/instance-heartbeat.test.js`

| Test | Description |
|------|-------------|
| `heartbeat registers instance` | Key exists with TTL. |
| `heartbeat refreshes ttl` | Subsequent beat updates expiration. |
| `liveInstances returns count` | Only non-expired instances counted. |
| `expired heartbeats are excluded` | TTL mock expiry removes instance. |

### `tests/events/change-coordinator.test.js`

| Test | Description |
|------|-------------|
| `initiate prepares change metadata` | Hash fields match event. |
| `initiate writes RULE_CHANGE_PREPARE` | Stream contains prepare event. |
| `poll returns not-ready` | Counter < expected. |
| `poll returns committed` | Counter reaches expected → `COMMITTED`, commit event appended. |
| `abort appends RULE_CHANGE_ABORT` | Reason recorded, state `ABORTED`. |
| `force-commit appends RULE_CHANGE_COMMIT` | Bypass counter. |
| `lock serializes concurrent changes` | Second initiate blocked. |
| `timeout aborts when ready < expected` | Abort event appended after timeout. |
| `uses heartbeat count for expectedInstances` | Quorum equals live instances. |

### `tests/events/change-consumer.test.js`

| Test | Description |
|------|-------------|
| `prepare loads and stages package` | Engine receives `_pendingRulePackage`, counter incremented. |
| `prepare validates package` | Invalid package does not stage and does not increment ready. |
| `commit swaps active package` | Engine `_rulePackage` updated, pending cleared, `lastAppliedChangeId` set. |
| `abort discards pending package` | Pending cleared, no swap. |
| `consumer resumes from last stream id` | Does not reprocess old events. |
| `ready endpoint returns 503 while staging` | Health/readiness gate. |

## 4. Integration Tests — Counter-based 2PC

### `tests/events/change-integration.test.js`

| Test | Description |
|------|-------------|
| `all instances stage before commit` | 3 mocked instances consume prepare, all increment ready, coordinator commits, all apply. |
| `split-version fleet prevented` | One instance does not acknowledge → commit blocked; only old package active on all instances. |
| `instance partition recovers after commit` | Partitioned instance later consumes commit and applies. |
| `timeout aborts pending change` | Coordinator aborts; instances discard staging; traffic stays on old package. |
| `invalid package aborts via validation` | Consumer refuses to stage; ready never reaches quorum; coordinator times out/aborts. |
| `heartbeat expiration lowers quorum` | One instance expires; coordinator recomputes expected count; commit proceeds. |

## 5. Fault Tests

- **Valkey unavailable:** Coordinator fails open with `RULE_STORE_UNAVAILABLE` or `COORDINATION_UNAVAILABLE`; main `/v1/route` still responds using current package.
- **Instance partition:** Unacknowledged instance does not block commit if quorum recomputed, otherwise commit stalls.
- **Timeout/abort:** Pending changes cleared on all instances; audit trail records abort.
- **Invalid package:** Validation errors surfaced to portal and logged; ready counter not incremented.
- **Heartbeat expiration:** TTL expiry removes instance from live count.

## 6. Contract Tests — `/portal/api/*`

### `tests/portal/portal-contract.test.js`

Spins up `createServer()` with `portalRouter` mounted, sends real HTTP requests, asserts:

| Endpoint | Contract |
|----------|----------|
| `GET /portal/api/policies` | 200 JSON with `policies` array. |
| `POST /portal/api/policies` | 201 creates policy, location-style response. |
| `GET /portal/api/policies/:treeKey` | 200 or 404 JSON. |
| `POST /portal/api/policies/:treeKey/draft` | 201, returns `version`/`checksum`. |
| `POST /portal/api/policies/:treeKey/publish` | 200, returns `activated`. |
| `POST /portal/api/policies/:treeKey/rollback` | 200 or 422. |
| `GET /portal/api/policies/:treeKey/history` | 200, `versions` array. |
| `POST /portal/api/simulate` | 200, `candidates` array. |
| `GET /portal/api/audit` | 200, `events` array. |
| `GET /portal/api/admin/changes/:changeId/status` | 200, `expectedInstances`, `ready`, `state`. |
| `POST /portal/api/admin/changes/:changeId/force-commit` | 200, state `COMMITTED`. |
| `POST /portal/api/admin/changes/:changeId/abort` | 200, state `ABORTED`. |

## 7. UI Smoke Tests — Manual Checklist

- [ ] `GET /portal` returns dashboard HTML with no console errors.
- [ ] Dashboard lists seeded policies with status badges.
- [ ] `GET /portal/policy/:treeKey` returns rule builder HTML.
- [ ] Rule builder renders existing rules as readable sentences.
- [ ] Adding a rule via UI and saving draft updates history.
- [ ] Inline simulator returns candidates for a sample payment context.
- [ ] Publish shows confirmation and activates version.
- [ ] History page shows timeline with rollback buttons.
- [ ] Rollback restores previous version and records audit.
- [ ] `/health/ready` returns 503 during pending 2PC change, 200 after commit.

## 8. Implementation Notes

- Create lightweight Valkey fake under `tests/helpers/fake-valkey.js` implementing the commands the event modules use.
- If `src/events/*.js` do not yet exist, create placeholder modules that throw `NOT_IMPLEMENTED` and tests that expect the interface (guiding the engineer).
- Add new test files to the existing glob `tests/**/*.test.js`; no `package.json` script changes needed.
- Run `npm test` and `npm run lint` after each new test file; fix lint errors before proceeding.

## 9. Gaps to Flag

- Portal route security (auth middleware) is intentionally out of scope; tests should not assert auth.
- Multi-environment and non-global scopes are not exercised beyond the data model; add scope-specific tests when implemented.
- Real Valkey cluster topology is not covered by the fake; production topology tests require a live Valkey or integration environment.
- UI visual regressions are out of scope for automated tests; rely on the manual checklist.
