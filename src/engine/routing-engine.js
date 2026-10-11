import { RoutingError, ValidationError } from '../errors/errors.js';
import { RuleBasedStrategy } from '../strategies/rule-based-strategy.js';
import { StrategyRegistry } from '../strategies/registry.js';
import { DecoratorRegistry } from '../decorators/registry.js';

export class RoutingEngine {
  constructor({ loader, validator, normalizer, logger, strategies = [], decorators = [] }) {
    this.loader = loader;
    this.validator = validator;
    this.normalizer = normalizer;
    this.logger = logger.child({ module: 'RoutingEngine' });
    this._registry = new StrategyRegistry(this.logger);
    this._decoratorRegistry = new DecoratorRegistry(this.logger);
    this._rulePackage = null;
    this._pendingRulePackage = null;
    this._loaded = false;
    this.lastAppliedChangeId = null;

    for (const strategy of strategies) {
      this._registry.register(strategy);
    }

    for (const decorator of decorators) {
      this._decoratorRegistry.register(decorator);
    }
  }

  async load(version = 'latest') {
    const pkg = await this.loader.load(version);
    return this._applyPackage(pkg);
  }

  /**
   * Reload the active package/forest from the store.
   * Used after a coordinated rule change commit is applied.
   */
  async reload() {
    const pkg = await this.loader.load('latest');
    return this._applyPackage(pkg);
  }

  /**
   * Apply a loaded package to the engine.
   * @param {Object} pkg
   * @returns {RoutingEngine}
   */
  _applyPackage(pkg) {
    const valid = this.validator.validate(pkg);
    if (!valid) {
      throw new ValidationError(
        `Rule package ${pkg.version} failed validation`,
        this.validator.errors
      );
    }

    this._rulePackage = pkg;

    // Replace the rule-based strategy so live traffic uses the new package.
    const ruleBased = new RuleBasedStrategy(pkg, { logger: this.logger });
    this._registry.replace(ruleBased);

    this._loaded = true;
    this.logger.info({ version: pkg.version, strategies: this._registry.list() }, 'Routing engine loaded');
    return this;
  }

  /**
   * Apply a staged package atomically. Called by the change consumer on COMMIT.
   * @param {Object} commitEvent
   */
  applyStagedPackage(commitEvent = {}) {
    if (!this._pendingRulePackage) {
      return;
    }

    const pkg = this._pendingRulePackage;
    this._pendingRulePackage = null;
    this._applyPackage(pkg);
    this.lastAppliedChangeId = commitEvent.changeId || pkg._changeId || null;
  }

  /**
   * Readiness gate: returns false while a change is staged but not committed.
   * @returns {boolean}
   */
  isReady() {
    return this._loaded && this._pendingRulePackage === null;
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
    for (const strategy of this._registry.all()) {
      if (typeof strategy.load === 'function' && !strategy._loaded) {
        await strategy.load();
      }
    }

    const strategy = this._registry.select(ctx);
    let decision = strategy.route(ctx, { startedAt });

    // Apply post-decision decorators to augment the routing decision.
    decision = this._decoratorRegistry.apply(decision, ctx);

    this.logger.info({
      requestId: ctx.requestId,
      strategy: strategy.name,
      decorators: this._decoratorRegistry.list(),
      decisionId: decision.decisionId,
      candidates: decision.candidates.length
    }, 'Route evaluated');

    return decision;
  }

  /**
   * Register an additional post-decision decorator.
   *
   * @param {import('../decorators/decorator.js').DecisionDecorator} decorator
   */
  registerDecorator(decorator) {
    this._decoratorRegistry.register(decorator);
    return this;
  }
}
