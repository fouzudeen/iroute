# Payment Gateway Routing Engine — Implementation Approach

## 1. Project Structure

```
/home/ahmed/code/iroute
├── package.json
├── README.md
├── .env.example
├── rules/
│   ├── example-rules.json
│   ├── rules-1.2.0.json
│   └── latest.json
├── scripts/
│   ├── package-rules.js
│   └── demo.js
├── src/
│   ├── index.js
│   ├── config/
│   │   └── logger.js
│   ├── context/
│   │   └── context.js
│   ├── engine/
│   │   └── routing-engine.js
│   ├── errors/
│   │   └── errors.js
│   └── rules/
│       ├── loader.js
│       ├── validator.js
│       ├── evaluator.js
│       ├── packager.js
│       └── schema.json
└── tests/
    └── evaluator.test.js
```

## 2. Core Modules

| Module | File | Responsibility |
|---|---|---|
| `RoutingEngine` | `src/engine/routing-engine.js` | Orchestrates rule loading, validation, normalization, and evaluation. Exposes `load(version)` and `route(paymentContext)`. |
| `RuleLoader` | `src/rules/loader.js` | Loads a versioned rule package from local store (`RULE_STORE_PATH`) or remote URL (`RULE_STORE_URL`). Supports `latest`. |
| `RuleValidator` | `src/rules/validator.js` | Validates rule packages against JSON Schema using Ajv. |
| `DecisionTreeEvaluator` | `src/rules/evaluator.js` | Recursively evaluates `and`/`or`/`not` condition trees and produces a prioritized provider list. |
| `RulePackager` | `src/rules/packager.js` | Builds immutable, versioned rule packages with a SHA-256 checksum and a `latest.json` pointer. |
| `ContextNormalizer` | `src/context/context.js` | Normalizes raw payment context (upper-cases country/currency, lower-cases payment method/card brand). |
| Error classes | `src/errors/errors.js` | `RoutingError`, `ValidationError`, `RuleNotFoundError`. |
| Logger | `src/config/logger.js` | Pino logger with environment-aware formatting. |

## 3. Rule Schema (JSON)

A package contains:
- `version`: semver string
- `createdAt`: ISO 8601 timestamp
- `description`: human-readable summary
- `rules[]`: ordered decision-tree rules

Each rule has:
- `id`: unique identifier
- `priority`: integer (higher = evaluated first)
- `condition`: nested condition tree
- `actions.providers[]`: prioritized PSP/PGSP list
- `actions.fallback`: optional single fallback provider

Condition nodes support:
- Logical: `and`, `or`, `not`
- Comparison: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `regex`
- Fields are dot-notated paths into the normalized context (`customer.riskScore`).

Example: `rules/example-rules.json`.

## 4. Evaluator Algorithm

1. Sort all rules by descending `priority`.
2. For each rule, recursively evaluate its condition against the normalized context.
3. If matched, capture rule id, priority, providers, and fallback.
4. Flatten matched providers, compute `score = (rulePriority * 1000) + providerWeight`.
5. Sort providers by descending score.
6. Return object containing version, requestId, match count, prioritized providers, and applied rule ids.

Complexity: O(R × C) where R = rules, C = average conditions per rule.

## 5. Versioning and Packaging

- Business Team edits source JSON rules.
- `npm run package:rules -- <source> <version> [description]` packages them into `rules/rules-<version>.json`.
- Package gets `createdAt` and SHA-256 `checksum`.
- `rules/latest.json` is updated to point to the newest package.
- Services can pin to a specific version or load `latest`.

## 6. Dependencies

- `ajv` + `ajv-formats`: JSON Schema validation
- `pino`: structured logging
- `semver`: semantic version validation in packager
- Node.js built-ins: `crypto`, `fs/promises`, `path`, `url`
- Dev/test: Node.js native test runner, ESLint

## 7. Configuration and Environment

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` enables pretty logging |
| `LOG_LEVEL` | Pino log level (`info`, `debug`, `warn`, `error`) |
| `RULE_STORE_PATH` | Local directory containing rule packages |
| `RULE_STORE_URL` | Optional remote rule store base URL |

See `.env.example`.

## 8. Error Handling

- Use domain-specific error classes extending `RoutingError`.
- Validation failures return `ValidationError` with Ajv error details.
- Missing packages throw `RuleNotFoundError`.
- Unknown operators throw `RoutingError`.
- Engine refuses to route until `load()` succeeds.
- All errors are logged with context (requestId, version).

## 9. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Invalid rules deployed | JSON Schema validation on load; fail closed (engine throws). |
| Circular or deeply nested conditions | Schema can set `maxDepth`; evaluator uses recursion with a depth guard (future). |
| Performance regression with many rules | Cache compiled evaluator; benchmark; add circuit breaker around remote loader. |
| No matching provider | Always define a low-priority default rule; result indicates `matches === 0`. |
| Tampered rule package | SHA-256 checksum in package; verify checksum on load (future). |
| Remote store outage | Support local fallback path; cache latest package. |
| Rule priority conflicts | Document priority bands; add audit log of matched rules. |
