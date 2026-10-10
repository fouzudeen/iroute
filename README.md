# iRoute — Payment Gateway Routing Engine

Determines which Payment Service Provider (PSP) or Payment Gateway Service Provider (PGSP) a payment request should be forwarded to, using versioned decision-tree rules maintained by the Business Team.

## Quick Start

```bash
npm install
npm test
npm start
```

## Architecture

- **RulePackage** — versioned set of decision-tree rules.
- **RuleLoader** — loads packages from a local store or remote URL.
- **RuleValidator** — validates packages against a JSON Schema.
- **DecisionTreeEvaluator** — recursively evaluates conditions and returns a prioritized provider list.
- **RoutingEngine** — orchestrates loading, validation, context normalization, and evaluation.
- **RulePackager** — creates immutable rule packages with SHA-256 checksums.
- **HTTP Server** — exposes `POST /v1/route`, `GET /health/live`, and `GET /health/ready`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full solution design.

## API Contract

### `POST /v1/route`

Routes a payment intent to the best available PSP/PGSP.

**Headers**

```
Content-Type: application/json
Authorization: Bearer <merchant-token>
Idempotency-Key: <uuid>
X-Rule-Version: <optional semver, e.g. 2.3.1>
```

**Request body**

```json
{
  "paymentIntentId": "pi-123",
  "merchantId": "m-123",
  "amount": { "value": 750, "currency": "EUR" },
  "instrument": {
    "type": "card",
    "bin": "424242",
    "cardCountry": "DE",
    "network": "visa",
    "tokenized": false
  },
  "context": {
    "mcc": "5812",
    "region": "EU",
    "customerCountry": "DE",
    "riskScore": 0.12,
    "threeDsRequested": true,
    "metadata": {}
  },
  "options": { "includeExplanation": false, "maxCandidates": 5 }
}
```

**200 response**

```json
{
  "routingDecisionId": "uuid",
  "ruleVersion": "1.2.0",
  "candidates": [
    {
      "pspId": "psp-premium-eu",
      "pgspId": null,
      "priority": 1,
      "score": 100100,
      "reasons": ["high-value-eu-cards"],
      "estimatedLatencyMs": 800,
      "estimatedCostBps": null
    }
  ],
  "excluded": [],
  "fallbackUsed": false,
  "decidedAt": "2026-10-10T12:00:00Z"
}
```

### `GET /health/live`

Returns `{ "status": "alive" }`.

### `GET /health/ready`

Returns `200` once a valid rule package is loaded, otherwise `503`.

## Rule Authoring

Rules are authored as JSON files. Each package contains:

- `version` — semantic version.
- `createdAt` — ISO 8601 timestamp.
- `description` — human-readable summary.
- `rules[]` — decision-tree rules.

Each rule contains:

- `id` — unique identifier.
- `priority` — integer; higher values are evaluated first.
- `condition` — nested predicate tree.
- `actions.providers[]` — prioritized list of eligible PSP/PGSPs.
- `actions.fallback` — optional fallback provider.

Supported condition operators:

- Logical: `and`, `or`, `not`
- Comparison: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `regex`

Fields are dot-notated paths into the normalized context, e.g. `customer.riskScore`.

See [`rules/example-rules.json`](rules/example-rules.json) for a full example and [`docs/RULE_AUTHORING.md`](docs/RULE_AUTHORING.md) for the complete guide.

## Packaging Rules

```bash
npm run package:rules -- rules/example-rules.json 1.2.0 "EU card routing package"
```

This creates:

- `rules/rules-1.2.0.json` — immutable package with SHA-256 checksum.
- `rules/latest.json` — pointer to the newest package.

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the HTTP server |
| `npm test` | Run the test suite |
| `npm run lint` | Run ESLint |
| `npm run package:rules` | Package a rule source file |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | — | `development` enables pretty logs |
| `LOG_LEVEL` | `info` | Pino log level |
| `RULE_STORE_PATH` | `./rules` | Local rule package directory |
| `RULE_STORE_URL` | — | Optional remote rule store base URL |

Copy `.env.example` to `.env` and adjust as needed.

## Project Structure

```
.
├── .github/workflows/ci.yml
├── rules/
│   ├── example-rules.json
│   ├── rules-1.2.0.json
│   └── latest.json
├── scripts/
│   ├── demo.js
│   └── package-rules.js
├── src/
│   ├── config/logger.js
│   ├── context/context.js
│   ├── engine/routing-engine.js
│   ├── errors/errors.js
│   ├── index.js
│   ├── rules/
│   │   ├── evaluator.js
│   │   ├── loader.js
│   │   ├── packager.js
│   │   ├── schema.json
│   │   └── validator.js
│   └── server.js
├── tests/
│   ├── engine.test.js
│   ├── evaluator.test.js
│   ├── integration.test.js
│   ├── loader.test.js
│   └── validator.test.js
├── ARCHITECTURE.md
├── README.md
├── IMPLEMENTATION.md
├── eslint.config.js
└── package.json
```

## License

MIT
