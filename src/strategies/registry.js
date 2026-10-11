import { RoutingError } from '../errors/errors.js';

export class StrategyRegistry {
  constructor(logger) {
    this._strategies = [];
    this._logger = logger?.child({ module: 'StrategyRegistry' }) || logger;
  }

  _assertValid(strategy) {
    if (!strategy || typeof strategy.canRoute !== 'function' || typeof strategy.route !== 'function') {
      throw new RoutingError('Invalid strategy: must implement canRoute() and route()');
    }
  }

  register(strategy) {
    this._assertValid(strategy);
    this._strategies.push(strategy);
    this._logger?.info({ strategy: strategy.name }, 'Strategy registered');
    return this;
  }

  /**
   * Replace the registered strategy with the same name, in place, so its
   * precedence (registration position) is preserved. If no strategy with that
   * name is registered, the strategy is appended instead.
   *
   * Used to hot-swap a strategy — e.g. the rule-based strategy when a new rule
   * package is applied — without the caller touching the internal list.
   *
   * @param {import('./strategy.js').RoutingStrategy} strategy
   * @returns {StrategyRegistry}
   */
  replace(strategy) {
    this._assertValid(strategy);
    const index = this._strategies.findIndex(s => s.name === strategy.name);
    if (index >= 0) {
      this._strategies[index] = strategy;
      this._logger?.info({ strategy: strategy.name }, 'Strategy replaced');
    } else {
      this._strategies.push(strategy);
      this._logger?.info({ strategy: strategy.name }, 'Strategy registered');
    }
    return this;
  }

  /**
   * Selects exactly one strategy for the given context.
   * Strategies are evaluated in registration order; the first strategy that
   * claims it can route wins. The default/fallback strategy should be registered
   * last and should always return true from canRoute().
   *
   * @param {import('../types.js').PaymentContext} context
   * @returns {import('./strategy.js').RoutingStrategy}
   */
  select(context) {
    for (const strategy of this._strategies) {
      if (strategy.canRoute(context)) {
        this._logger?.debug({ strategy: strategy.name }, 'Strategy selected');
        return strategy;
      }
    }
    throw new RoutingError('No routing strategy available for context');
  }

  list() {
    return this._strategies.map(s => s.name);
  }

  get(name) {
    return this._strategies.find(s => s.name === name) || null;
  }

  /**
   * Snapshot of the registered strategies in registration order. Returns a copy
   * so callers can iterate without exposing (and mutating) the internal list.
   *
   * @returns {import('./strategy.js').RoutingStrategy[]}
   */
  all() {
    return [...this._strategies];
  }
}
