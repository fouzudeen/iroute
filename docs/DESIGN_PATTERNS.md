# Design Patterns in the Route Engine — PGSP Determination

How the iRoute routing engine uses design patterns to decide which PSP/PGSP a
payment request is forwarded to. Every claim below is anchored to `file:line`
and backed by the passing test suite (`npm test`).

## How this was analysed

The analysis was produced with the **codegraph** code-intelligence engine. In the
session that produced this document the codegraph MCP server was registered but
disabled, so the same engine was driven through the `codegraph` CLI, whose
`explore` / `node` / `context` / `callers` / `callees` / `impact` subcommands
emit the same output as the `codegraph_*` MCP tools.

Index at time of analysis (`codegraph status`): 65 files, 624 nodes, 1,782 edges,
*"Index is up to date"*.

Key graph finding — the dynamic-dispatch edge that is the Strategy pattern's
polymorphism:

```
route → route  [dynamic: interface → impl @src/strategies/direct-bank-strategy.js:28]
```

## PGSP-determination flow

```
POST /v1/route
 └─ handleRoute                              src/server.js:89   (per-request X-Rule-Version pinning → fresh engine)
     └─ RoutingEngine.route                  src/engine/routing-engine.js:106
         ├─ ContextNormalizer.normalize      src/context/context.js:4
         ├─ lazy strategy.load()             (async strategies, e.g. DirectBankStrategy.load)
         ├─ StrategyRegistry.select(ctx)     src/strategies/registry.js:27   ← first canRoute() wins
         ├─ strategy.route(ctx)              DirectBankStrategy.route :28  |  RuleBasedStrategy.route :23
         │     └─ ForestEvaluator / DecisionTreeEvaluator
         │                                   src/rules/forest-evaluator.js:11 | src/rules/evaluator.js:3
         └─ DecoratorRegistry.apply(decision, ctx)   src/decorators/registry.js:26
```

## Patterns and their role in picking the PGSP

| # | Pattern | Where | Role in PGSP determination |
|---|---------|-------|----------------------------|
| 1 | **Strategy** | `RoutingStrategy` base `src/strategies/strategy.js:1`; `RuleBasedStrategy`, `DirectBankStrategy`; selected at `src/strategies/registry.js:27` | The core decision: *which mechanism* chooses the provider. `DirectBankStrategy.canRoute` claims the request when `issuerBin` has a BIN mapping; `RuleBasedStrategy.canRoute` always returns `true` and is the fallback. |
| 2 | **Registry** | `StrategyRegistry` `src/strategies/registry.js:3`, `DecoratorRegistry` `src/decorators/registry.js:3` | Ordered containers with `register/list/get`; reject invalid participants (`registry.js:9`). Registration order encodes precedence — DirectBank is registered first, so it wins for mapped BINs. |
| 3 | **Template Method** | abstract hooks `src/strategies/strategy.js:12/21`; `src/decorators/decorator.js:15/26` | Base classes fix the contract (`canRoute`/`route`, `canDecorate`/`decorate`) and throw/default; subclasses fill only the variation points. |
| 4 | **Chain of Responsibility** | `DecoratorRegistry.apply` `src/decorators/registry.js:26` | Threads the `RoutingDecision` through each decorator in order; each decides via `canDecorate` whether to act; a throwing decorator is isolated — `current = before` (`registry.js:46`) and provenance records `Name:failed`. |
| 5 | **Decorator** | `DecisionDecorator` base + `FallbackDecorator`, `ComplianceDecorator`, `CapacityScoringDecorator` | Structurally augments the decision immutably (`{...decision}`) *after* selection: Fallback inserts a provider when candidates are empty; Compliance prunes sanctioned-country candidates into `excluded` + flags high-risk/3DS; CapacityScoring re-ranks by retry penalty / promotion bonus. |
| 6 | **Factory** | `createRoutingDecision` `src/types.js:72`; `createEngine` `src/index.js:33` | Typed `RoutingDecision` factory; composition-root factory that assembles the engine graph per options (which strategies/decorators are enabled). |
| 7 | **Interpreter** | `DecisionTreeEvaluator._match` `src/rules/evaluator.js:33` / `_compare` `src/rules/evaluator.js:46` | Interprets the rule *condition AST*: `and/or/not` composition over `eq/ne/gt/gte/lt/lte/in/notIn/regex` terminals. `ARCHITECTURE.md:289` calls it an "in-memory compiled AST (custom engine)". |
| 8 | **Composite** | `ForestEvaluator` `src/rules/forest-evaluator.js:11` | Treats a forest as N `DecisionTreeEvaluator` trees (`:38`), merges/de-dupes providers by `type:id` (`:80`), sorts by score → rulePriority → slaMs. Lets scope-resolved trees be added without binding selection to load time. |
| 9 | **Facade** | `RoutingEngine.route` `src/engine/routing-engine.js:106` | One coarse operation over loader, validator, normalizer, strategy registry and decorator registry. |
| 10 | **Adapter / Ports & Adapters** | `IRuleStore` `src/repository/rule-store.js:52` → `SqliteRuleStore` `src/repository/sqlite-rule-store.js:27` (`extends IRuleStore`); `RuleLoader.load` adapts store/remote/file | Lets the rule source (SQLite today, Postgres later) and transport swap without touching the engine. |

*(Minor: the module-level pino `logger` in `src/config/logger.js` acts as a shared singleton.)*

## Verification

- `npm test` → **64 tests, 6 suites, 64 pass, 0 fail**.
- Pattern claims are asserted by the suite, not just inferred:
  - `tests/strategy.test.js` — "StrategyRegistry selects first mutually exclusive
    strategy"; "Engine uses DirectBankStrategy for mapped BIN and
    RuleBasedStrategy otherwise".
  - `tests/decorators.test.js` — "applies decorators in order and records
    provenance"; "skips failed decorators and preserves decision".
- Every claim was re-checked against on-disk source at the cited `file:line`.

## Observations / trade-offs

- **Registration order is the precedence contract.** `StrategyRegistry.select`
  returns the first `canRoute()` match, so correctness depends on
  `DirectBankStrategy` being registered before `RuleBasedStrategy`. This is
  implicit; a mis-ordered registration silently changes routing.
- **Encapsulation leak.** `RoutingEngine._applyPackage` reaches into
  `this._registry._strategies` and splices the array in place
  (`src/engine/routing-engine.js:59-65`) to hot-swap the rule package — a
  private-field reach-in rather than a `replace()` method on the registry. It
  works, but couples the engine to the registry's internals.
- **Decorators run for all strategies**, including direct-bank decisions, so
  compliance/fallback/scoring apply uniformly — a deliberate, consistent
  post-processing layer rather than per-strategy logic.
