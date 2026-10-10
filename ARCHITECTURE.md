# iRoute Payment Gateway Routing Engine — Solution Architecture

This document expands the machine-validated `design.json` into a narrative that engineers can use for implementation.

## 1. Component Diagram

The rendered component diagram is saved as `iroute-architecture.html`. Open it in a browser to view the SVG.

### Logical modules

| Module | Responsibility |
|--------|----------------|
| **API Gateway** | TLS termination, merchant API-key validation, rate limiting, WAF, routing request ingress. |
| **AuthN/AuthZ** | Verifies merchant JWT/API-key, resolves scopes and entitlements; returns normalized principal. |
| **Routing API** | Validates request schema, orchestrates enrichment and strategy selection, applies post-processing, returns ranked result, emits events. |
| **Context Enrichment** | Fetches merchant routing config, card/BIN metadata, FX rates, risk/fraud signals and PSP health. |
| **Strategy Registry** | Maintains an ordered list of mutually exclusive routing strategies; selects the first strategy whose `canRoute()` predicate matches the context. |
| **Rule-Based Strategy** | Evaluates versioned decision-tree rules to produce a prioritized PSP/PGSP list. |
| **Direct Bank Strategy** | Routes directly to a bank-specific PGSP/PSP based on `issuerBin`. |
| **Rule Repository** | Loads the active rule package from the central store, maintains in-memory cache, handles reload and rollback. |
| **Evaluation Engine** | Walks the decision tree, evaluates predicates, computes per-PSP priority scores, returns ordered candidates. |
| **Business Portal** | UI for business users to author, preview, test and publish decision-tree rules and BIN mappings. |
| **Metadata DB** | Stores package versions, active version pointers per channel/tenant, audit log and approval workflow state. |
| **Object Store** | Immutable artifact storage for versioned rule packages (tar.gz/zip with manifest and checksums). |
| **Event Bus** | Emits `route.decision` events for downstream dispatcher, analytics and audit consumers. |
| **Dispatcher** | Uses the ranked PSP/PGSP list to submit the payment intent and handle retries/failover. |

## 2. Data Flow

1. Merchant app calls `POST /v1/route` (or `GET /v1/route/health`) through API Gateway with `Authorization` header, `Idempotency-Key`, payment amount/currency/card/MCC/region and optional `X-Rule-Version`.
2. API Gateway validates TLS, API-key rate limits and WAF rules, then forwards the request to the Routing API.
3. Routing API normalizes the payload, calls AuthN/AuthZ to resolve merchant profile and permissions.
4. Context Enrichment gathers merchant routing config, BIN/issuer, FX, risk score and PSP health/latency signals with short timeouts.
5. Rule Repository resolves the active rule package for the merchant/channel (or pinned version) from local cache; on cache miss it fetches the active pointer from Metadata DB and downloads the artifact from Object Store.
6. Strategy Registry iterates through registered strategies in priority order and selects the first strategy whose `canRoute()` predicate matches the enriched context (e.g. `DirectBankStrategy` if a BIN mapping exists, otherwise `RuleBasedStrategy`).
7. The selected strategy produces a typed `RoutingDecision` object containing candidates, provenance (strategy name, version, matched rules, context fingerprint), and latency.
8. Decorator Registry runs the ordered post-decision decorator pipeline (fallback, compliance, capacity scoring, etc.), augmenting the decision and recording each applied decorator in provenance.
9. Routing API returns the final ranked result to the merchant.
9. Routing API emits a `route.decision` event to the Event Bus for the Dispatcher, analytics and audit log consumers.
10. Dispatcher consumes the event and forwards the payment intent to the top-priority PSP, falling back to the next candidate on failure.

## 3. Rule Storage & Versioning Strategy

The central store is split into two layers: a **metadata layer** in PostgreSQL for queries and lifecycle state, and an **artifact layer** in S3/GCS/Azure Blob for immutable rule package binaries. A repository abstraction (`IRuleStore`) hides the backend from the engine.

### Package structure

```
rule-package-<id>-<version>.tar.gz
├── manifest.json          # id, version, channel, schemaVersion, createdAt, checksums
├── schema.json            # JSON Schema for the decision tree
├── decision-tree.json     # nodes, predicates, actions
├── defaults.json          # fallback rules and default candidate list
└── tests.json             # expected outcomes for sample contexts
```

### Versioning model

- **Semantic versioning** (`major.minor.patch`).
- **Immutable artifacts**: once uploaded, a version is never mutated; only the active pointer changes.
- **Channels**: `sandbox`, `staging`, `production`.
- **Active pointer**: a single row per `(channel, scope)` where scope can be global, region or merchant. Atomic updates via `UPDATE ... WHERE version = current` optimistic locking.
- **Canary / pinning**: a merchant can be pinned to a specific version via `X-Rule-Version`; default uses the channel active pointer.
- **Lifecycle workflow**: `draft` → `validate` (schema + tests + dry-run) → `approve` → `publish` → `activate`. Rollback switches the active pointer to a previous version instantly.
- **Audit**: every edit, publish and pointer change is appended to an immutable audit log table (`rule_audit_log`) with user, diff and timestamp.

### Store interface (TypeScript)

```typescript
interface IRuleStore {
  getActiveVersion(channel: string, scope?: Scope): Promise<VersionRef>;
  getPackage(versionRef: VersionRef): Promise<RulePackage>;
  publish(package: RulePackageArtifact, channel: string): Promise<VersionRef>;
  setActive(versionRef: VersionRef, channel: string, scope: Scope): Promise<void>;
  listVersions(channel: string, limit: number): Promise<VersionRef[]>;
}
```

## 4. Strategy Registry & Decision Object

### Strategy model

Routing is handled by an ordered list of mutually exclusive strategies. Each strategy implements:

- `name`: stable identifier.
- `canRoute(context)`: returns `true` if the strategy applies to the context.
- `route(context)`: returns a typed `RoutingDecision`.

Out-of-the-box strategies:

| Strategy | Selection predicate | Use case |
|----------|---------------------|----------|
| `DirectBankStrategy` | `issuerBin` has a mapping | Direct bank-to-PGSP rails |
| `RuleBasedStrategy` | always true (registered last) | General decision-tree routing |

Additional strategies (e.g. `PlaidOpenBankingStrategy`, `NetworkTokenStrategy`) can be registered without changing existing strategies.

### Post-decision decorators

After a strategy produces a `RoutingDecision`, an ordered pipeline of **decorators** augments the decision or the payment context. Decorators are mutually composable and each records its effect in the decision provenance.

Each decorator implements:

- `canDecorate(decision, context)`: whether it should run.
- `decorate(decision, context)`: returns a new `RoutingDecision`.

Out-of-the-box decorators:

| Decorator | Purpose | Trigger |
|-----------|---------|---------|
| `FallbackDecorator` | Inserts a fallback provider if no candidates were selected | `candidates.length === 0` |
| `ComplianceDecorator` | Flags high-risk / sanctioned contexts and excludes non-compliant candidates | risk score or sanctioned country |
| `CapacityScoringDecorator` | Adjusts candidate scores based on retry attempts and promotions | retry/promotion metadata present |

The `DecoratorRegistry` runs decorators in registration order, skips those whose `canDecorate` returns false, catches and logs failures without corrupting the decision, and records `provenance.decorators` with the list of applied decorators.

### RoutingDecision typed object

Every route evaluation returns:

```typescript
interface RoutingDecision {
  __type: 'RoutingDecision';
  decisionId: string;
  requestId: string;
  ruleVersion: string;
  candidates: Provider[];
  excluded: Provider[];
  fallbackUsed: boolean;
  provenance: {
    strategyName: string;
    strategyVersion: string;
    evaluatedAt: string;
    matchedRules?: string[];
    contextFingerprint?: object;
  };
  latencyMs: number;
  decidedAt: string;
}
```

The `__type` discriminator and `provenance` block guarantee provenance and make decisions auditable and replayable.

## 5. Decision Tree Evaluation Engine Design

### Rule model

A rule package contains a tree of nodes. Each node has:

- `id`, `description`
- `predicate`: an expression using operators `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `range`, `regex`, `exists`, `and`, `or`, `not`.
- `action`: one or more of `include(PSP, weight)`, `exclude(PSP)`, `setPriority(PSP, priority)`, `setScore(PSP, delta)`.
- `children`: nested nodes evaluated when the predicate is true.

### Evaluation algorithm

1. **Load & compile**: on package load, parse the tree into an in-memory AST/DAG and optionally compile hot predicates into V8-friendly predicate functions.
2. **Normalize context**: map request fields + enriched data into a flat typed `EvaluationContext` (e.g., `amount`, `currency`, `cardCountry`, `mcc`, `riskScore`).
3. **Tree walk**: recursively evaluate each node. If `predicate(context)` is true, apply actions and recurse into children.
4. **Scoring**: maintain a map `Map<PSP, CandidateScore>`. Actions add/subtract scores, set explicit priorities, or exclude candidates. Exclusion is final.
5. **Tie-breaking**: after traversal, sort candidates by `(score desc, configuredPriority asc, psp.successRate desc, psp.latencyP99 asc)`.
6. **Post-processing**: apply PSP health/capacity filters and append the configured fallback list if no candidate remains.
7. **Output**: return ordered array of `{ psp, priority, score, matchedRules[], excluded: boolean }` wrapped into a `RoutingDecision` by the `RuleBasedStrategy`.

### Key design choices

- **Determinism**: same `(ruleVersion, context)` always yields same result; rule evaluation is pure with no side effects.
- **Performance**: tree cached in memory; hot path avoids I/O. Typical target p99 < 5 ms per evaluation.
- **Extensibility**: custom predicate plugins registered by name (e.g., `pspUptime`, `merchantVolume`).
- **Explainability**: the engine records every matched rule, score delta and tie-breaker so `/route` can optionally return `explanation: true` details.
- **Safety**: a maximum tree depth and node count are enforced at publish time to prevent runaway evaluation.

## 5. Packaging & Deployment Approach

### Build pipeline

```
Business Portal / Git
        |
        v
   Rule editor ──► draft package
        |
        v
   CI / rule-linter
   - JSON Schema validation
   - predicate syntax checks
   - cycle / depth limits
   - unit tests against tests.json
   - dry-run on historical sample
        |
        v
   Artifact build
   - deterministic tar.gz
   - SHA-256 checksum
   - signed with KMS key (optional)
        |
        v
   Publish
   - upload artifact to object store
   - register version row in Metadata DB
   - mark active for channel/scope
```

### Deployment model

- **Immutable containers**: Docker image embeds a baseline rule package for startup resilience, but services prefer the active package from the central store.
- **Runtime reload**: services subscribe to cache-invalidation events (Redis pub/sub, SNS or Kafka) on new publishes. They fetch the new package, validate it, and swap the in-memory tree atomically.
- **Rollback**: change the active pointer in Metadata DB and broadcast invalidation; all nodes reload within seconds.
- **Multi-region**: object store + DB replicated across regions; active pointer is per-region to support staggered rollouts.
- **Pinning**: `X-Rule-Version` header allows per-request testing of a non-active version without changing channel pointer.

### Package registry API

- `GET /packages/:version` – download artifact
- `GET /channels/:channel/active` – resolve active version
- `POST /packages/:version/activate/:channel` – promote version
- `GET /packages` – list versions with metadata

## 6. API Contract

`POST https://api.iroute.example.com/v1/route`

### Headers

- `Content-Type: application/json`
- `Authorization: Bearer <merchant-jwt-or-api-key>`
- `Idempotency-Key: <uuid>`
- `X-Rule-Version: <optional semver, e.g. 2.3.1>`

### Request body

```json
{
  "paymentIntentId": "string",
  "merchantId": "string",
  "amount": { "value": 100.00, "currency": "USD" },
  "instrument": {
    "type": "card",
    "bin": "424242",
    "cardCountry": "US",
    "network": "visa",
    "tokenized": false
  },
  "context": {
    "mcc": "5812",
    "region": "NA",
    "customerCountry": "US",
    "riskScore": 0.12,
    "threeDsRequested": true,
    "metadata": {}
  },
  "options": { "includeExplanation": false, "maxCandidates": 5 }
}
```

### 200 response

```json
{
  "routingDecisionId": "uuid",
  "requestId": "pi-123",
  "ruleVersion": "2.3.1",
  "strategy": "RuleBasedStrategy",
  "candidates": [
    { "pspId": "psp-a", "pgspId": null, "priority": 1, "score": 1250, "reasons": ["rule-001"], "estimatedLatencyMs": 120, "estimatedCostBps": 85 }
  ],
  "excluded": [],
  "fallbackUsed": false,
  "provenance": {
    "strategyName": "RuleBasedStrategy",
    "strategyVersion": "2.3.1",
    "evaluatedAt": "2026-10-10T12:00:00Z",
    "matchedRules": ["rule-001"],
    "contextFingerprint": { "amount": 100, "currency": "USD", "cardBrand": "visa" }
  },
  "latencyMs": 3,
  "decidedAt": "2026-10-10T12:00:00Z"
}
```

Error codes: `INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `RULE_VERSION_NOT_FOUND`, `NO_CANDIDATE`, `RATE_LIMITED`, `INTERNAL_ERROR`, `RULE_STORE_UNAVAILABLE`.

## 7. Tech Stack Recommendation

| Category | Technology | Rationale |
|----------|------------|-----------|
| Runtime / Framework | Node.js 20 LTS + Fastify 4 | Fast, low-overhead HTTP framework with built-in JSON schema validation, request lifecycle hooks and plugin ecosystem; fits high-throughput routing decisions. |
| Language | TypeScript 5.x | Type safety for rule ASTs, API contracts and store interfaces; reduces runtime schema errors and improves refactoring confidence. |
| Rule evaluation | In-memory compiled AST (custom engine) | Deterministic, sub-millisecond evaluation; no external interpreter needed. JSON-logic libraries can be used as a parser fallback. |
| Metadata store | PostgreSQL 15+ | ACID guarantees for active-pointer updates, audit log and versioning metadata; supports row-level locking and JSONB for flexible rule metadata. |
| Artifact store | AWS S3 (or GCS / Azure Blob) | Durable, cheap, immutable object storage with versioning, lifecycle policies and signed URLs for secure artifact distribution. |
| Cache & reload signaling | Redis Cluster | Local LRU cache backed by Redis pub/sub for near-instant invalidation across horizontally scaled nodes. |
| Event bus | Kafka or AWS SQS/SNS | Durable, ordered events for route decisions, audit and downstream dispatch; decouples routing from PSP submission. |
| Observability | OpenTelemetry + Prometheus + Grafana + structured logs (pino) | Distributed tracing of evaluate/store/enrichment paths, latency histograms and business dashboards. |
| Container platform | Docker + Kubernetes (EKS/GKE) | Horizontal pod autoscaling, rolling deployments, readiness probes that verify rule package loaded. |
| Schema / API docs | JSON Schema + OpenAPI 3.1 | Machine-readable contracts for validation, client generation and Business Portal form rendering. |
| CI/CD | GitHub Actions / GitLab CI | Automated lint, test, package build, signing and promotion pipeline integrated with the artifact store. |

## 8. Scalability & Fault Tolerance

- Stateless routing service instances allow horizontal scaling behind a load balancer; no session affinity required.
- Active rule package is cached in-process after first load; evaluation path requires no network calls under steady state.
- Redis-backed distributed cache reduces load on PostgreSQL and object store for package metadata and artifacts.
- Embedded fallback rule package lets the service continue operating if the central store is unreachable, with a 503 warning.
- Circuit breakers (e.g., opossum) protect evaluation from slow context-enrichment or PSP health services.
- Async enrichment with aggressive timeouts; missing data degrades gracefully by skipping predicates that depend on it.
- Rate limiting per merchant and per IP at API Gateway prevents thundering-herd and abuse.
- Kubernetes HPA scales on CPU and custom metric `route.p99_latency`; readiness probe fails until a valid rule tree is loaded.
- Multi-region active-active deployment with per-region active pointers supports locality and rolling upgrades.
- Idempotency keys ensure repeated `POST /route` calls do not create duplicate downstream payment attempts.

## 9. Observability

- Distributed OpenTelemetry traces span API Gateway → Routing API → Enrichment → Rule Repository → Evaluation Engine → Event Bus.
- Prometheus metrics: `route_requests_total`, `route_latency_seconds`, `rule_evaluation_duration_seconds`, `rule_cache_hit_ratio`, `package_load_duration_seconds`, `psp_candidate_score`, `route_fallback_total`, `rule_store_errors_total`.
- Structured JSON logs (pino) with `trace_id`, `span_id`, `merchant_id`, `payment_intent_id`, `rule_version` and matched rule IDs.
- Grafana dashboards: decision latency percentiles, per-PSP routing distribution, rule version adoption, cache hit rate and enrichment failure rate.
- Alerting rules: p99 latency > 50 ms, error rate > 0.1%, package load failure, no active version for channel, rule store unreachable > 30 s.
- Audit events emitted to Kafka/SQS for every route decision and every rule publish/rollback, enabling compliance replay and business analytics.
- Health endpoints: `/health/live` (process up) and `/health/ready` (rule package loaded and store reachable).
- Business Portal exposes per-rule match counts and A/B-style comparison between versions before full activation.
