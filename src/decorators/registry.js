import { RoutingError } from '../errors/errors.js';

export class DecoratorRegistry {
  constructor(logger) {
    this._decorators = [];
    this._logger = logger?.child({ module: 'DecoratorRegistry' }) || logger;
  }

  register(decorator) {
    if (!decorator || typeof decorator.canDecorate !== 'function' || typeof decorator.decorate !== 'function') {
      throw new RoutingError('Invalid decorator: must implement canDecorate() and decorate()');
    }
    this._decorators.push(decorator);
    this._logger?.info({ decorator: decorator.name }, 'Decorator registered');
    return this;
  }

  /**
   * Runs decorators in registration order. Each decorator receives the latest
   * decision and the original normalized payment context.
   *
   * @param {import('../types.js').RoutingDecision} decision
   * @param {import('../types.js').PaymentContext} context
   * @returns {import('../types.js').RoutingDecision}
   */
  apply(decision, context) {
    let current = decision;
    const applied = [];

    for (const decorator of this._decorators) {
      if (!decorator.canDecorate(current, context)) {
        continue;
      }

      const before = current;
      try {
        current = decorator.decorate(current, context);
        if (!current || current.__type !== 'RoutingDecision') {
          throw new RoutingError(`Decorator ${decorator.name} did not return a RoutingDecision`);
        }
        applied.push(decorator.name);
        this._logger?.debug({ decorator: decorator.name, decisionId: current.decisionId }, 'Decorator applied');
      } catch (err) {
        this._logger?.error({ err, decorator: decorator.name }, 'Decorator failed');
        // Preserve original decision if a decorator throws.
        current = before;
        applied.push(`${decorator.name}:failed`);
      }
    }

    // Record decorator provenance on the final decision.
    current.provenance.decorators = applied;
    current.provenance.decoratorCount = applied.length;
    return current;
  }

  list() {
    return this._decorators.map(d => d.name);
  }
}
