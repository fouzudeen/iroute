import { DecisionTreeEvaluator } from '../rules/evaluator.js';
import { RoutingError, ValidationError } from '../errors/errors.js';
import { RuleBasedStrategy } from '../strategies/rule-based-strategy.js';
import { DirectBankStrategy } from '../strategies/direct-bank-strategy.js';
import { StrategyRegistry } from '../strategies/registry.js';

export class RoutingEngine {
  constructor({ loader, validator, normalizer, logger, strategies = [] }) {
    this.loader = loader;
    this.validator = validator;
    this.normalizer = normalizer;
    this.logger = logger.child({ module: 'RoutingEngine' });
    this._registry = new StrategyRegistry(this.logger);
    this._rulePackage = null;
    this._loaded = false;

    for (const strategy of strategies) {
      this._registry.register(strategy);
    }
  }

  async load(version = 'latest') {
    const pkg = await this.loader.load(version);
    const valid = this.validator.validate(pkg);
    if (!valid) {
      throw new ValidationError(
        `Rule package ${pkg.version} failed validation`,
        this.validator.errors
      );
    }

    this._rulePackage = pkg;

    // Auto-register the rule-based strategy from the loaded package if not already present.
    if (!this._registry.list().includes('RuleBasedStrategy')) {
      this._registry.register(new RuleBasedStrategy(pkg, { logger: this.logger }));
    }

    this._loaded = true;
    this.logger.info({ version: pkg.version, strategies: this._registry.list() }, 'Routing engine loaded');
    return this;
  }

  /**
   * Register an additional routing strategy. Strategies must be mutually exclusive
   * in their canRoute() logic; the first matching strategy wins.
   *
   * @param {import('../strategies/strategy.js').RoutingStrategy} strategy
   */
  registerStrategy(strategy) {
    this._registry.register(strategy);
    return this;
  }

  async route(paymentContext) {
    if (!this._loaded) {
      throw new RoutingError('Engine not loaded. Call load() first.');
    }

    const ctx = this.normalizer.normalize(paymentContext);
    const startedAt = Date.now();

    // Lazy-load any strategy that supports async load.
    for (const strategy of this._registry._strategies) {
      if (typeof strategy.load === 'function' && !strategy._loaded) {
        await strategy.load();
      }
    }

    const strategy = this._registry.select(ctx);
    const decision = strategy.route(ctx, { startedAt });

    this.logger.info({
      requestId: ctx.requestId,
      strategy: strategy.name,
      decisionId: decision.decisionId,
      candidates: decision.candidates.length
    }, 'Route evaluated');

    return decision;
  }
}
