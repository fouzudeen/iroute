import { RoutingError } from '../errors/errors.js';

export class StrategyRegistry {
  constructor(logger) {
    this._strategies = [];
    this._logger = logger?.child({ module: 'StrategyRegistry' }) || logger;
  }

  register(strategy) {
    if (!strategy || typeof strategy.canRoute !== 'function' || typeof strategy.route !== 'function') {
      throw new RoutingError('Invalid strategy: must implement canRoute() and route()');
    }
    this._strategies.push(strategy);
    this._logger?.info({ strategy: strategy.name }, 'Strategy registered');
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
}
