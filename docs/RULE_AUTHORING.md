# Rule Authoring Guide

This guide is for the Business Team and anyone who needs to create or update payment routing rules.

## Concepts

- **Rule package** — a versioned JSON file that contains all routing rules for one scope (e.g. EU cards).
- **Rule** — a single routing decision with a condition and an action.
- **Condition** — a predicate that is evaluated against the payment context.
- **Action** — the list of PSP/PGSP candidates returned when the condition matches.
- **Priority** — an integer that determines evaluation order. Higher numbers run first.

## File Format

```json
{
  "version": "1.2.0",
  "createdAt": "2026-10-10T00:00:00.000Z",
  "description": "EU card routing package",
  "rules": [
    {
      "id": "high-value-eu-cards",
      "priority": 100,
      "description": "Route high-value EU card transactions to premium PSPs",
      "condition": { ... },
      "actions": {
        "providers": [ ... ],
        "fallback": { ... }
      }
    }
  ]
}
```

## Conditions

### Logical operators

```json
{ "operator": "and", "conditions": [ ... ] }
{ "operator": "or", "conditions": [ ... ] }
{ "operator": "not", "conditions": [ ... ] }
```

### Comparison operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | equal | `{ "operator": "eq", "field": "currency", "value": "EUR" }` |
| `ne` | not equal | `{ "operator": "ne", "field": "country", "value": "US" }` |
| `gt` | greater than | `{ "operator": "gt", "field": "amount", "value": 100 }` |
| `gte` | greater or equal | `{ "operator": "gte", "field": "amount", "value": 500 }` |
| `lt` | less than | `{ "operator": "lt", "field": "customer.riskScore", "value": 30 }` |
| `lte` | less or equal | `{ "operator": "lte", "field": "customer.riskScore", "value": 70 }` |
| `in` | value in list | `{ "operator": "in", "field": "country", "value": ["DE", "FR"] }` |
| `notIn` | value not in list | `{ "operator": "notIn", "field": "country", "value": ["XX"] }` |
| `regex` | matches regex | `{ "operator": "regex", "field": "cardBrand", "value": "^visa$" }` |

### Field paths

Use dot notation to reference nested context fields:

- `amount`
- `currency`
- `country`
- `cardBrand`
- `customer.riskScore`
- `merchant.mcc`
- `metadata.promotionCode`

## Actions

### Providers

Each matched rule returns a list of providers. Providers are scored and sorted across all matched rules.

```json
{
  "providers": [
    { "id": "psp-premium-eu", "type": "psp", "weight": 100, "slaMs": 800 },
    { "id": "pgsp-eu-backup", "type": "pgsp", "weight": 80, "slaMs": 1200 }
  ]
}
```

- `id` — provider identifier (required).
- `type` — `psp` or `pgsp`.
- `weight` — local priority within the rule (default 100).
- `slaMs` — expected latency in milliseconds.

### Fallback

A single fallback provider can be attached to a rule. It is returned when no other rule matches.

```json
{
  "fallback": { "id": "psp-global", "type": "psp", "weight": 50 }
}
```

## Scoring

The final provider order is computed as:

```
score = (rulePriority * 1000) + providerWeight
```

Providers are returned in descending score order. If the same provider appears in multiple rules, each appearance is kept as a separate candidate; callers may deduplicate if desired.

## Best Practices

1. **Always provide a default rule** with low priority so every request gets a route.
2. **Use high priorities sparingly** for overrides (e.g. sanctions, merchant whitelists).
3. **Keep conditions precise** to avoid unintended matches.
4. **Use `description`** to explain the business intent.
5. **Validate locally** before publishing:

   ```bash
   npm run package:rules -- rules/my-rules.json 1.3.0 "My change"
   npm test
   ```

7. **Version immutably** — never edit `rules/rules-X.Y.Z.json` directly. Edit the source file and re-package.

## Direct Bank BIN Mappings

Some payments are routed through the Direct Bank strategy instead of decision-tree rules. BIN mappings live in `rules/bin-mapping.json` and are maintained by the Business Team.

Each entry maps an `issuerBin` to a bank code and an ordered list of PGSP/PSP providers. When a request's `instrument.bin` matches an entry, the `DirectBankStrategy` is selected and the rule-based strategy is skipped.

```json
{
  "mappings": {
    "424242": {
      "bankCode": "CHASE",
      "providers": [
        { "id": "pgsp-chase-direct", "type": "pgsp", "weight": 100 }
      ]
    }
  }
}
```

## Example: Add a Merchant Whitelist

```json
{
  "id": "merchant-m123-whitelist",
  "priority": 1000,
  "description": "Merchant M123 requires PSP-C",
  "condition": {
    "operator": "eq",
    "field": "merchant.id",
    "value": "m123"
  },
  "actions": {
    "providers": [
      { "id": "psp-c", "type": "psp", "weight": 100 }
    ]
  }
}
```

## Publishing

1. Edit the source rule file (e.g. `rules/example-rules.json`).
2. Run the packager:

   ```bash
   npm run package:rules -- rules/example-rules.json 1.3.0 "Added merchant whitelist"
   ```

3. Commit the source file and the generated `rules/rules-1.3.0.json` and `rules/latest.json`.
4. Open a PR. CI will validate the package.
5. After merge, the deployment pipeline activates the new `latest` package.
