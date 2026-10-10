export class DecisionDecorator {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
  }

  /**
   * Returns true if this decorator should run for the given decision/context.
   * Override in subclasses for conditional decoration.
   *
   * @param {import('../types.js').RoutingDecision} _decision
   * @param {import('../types.js').PaymentContext} _context
   * @returns {boolean}
   */
  canDecorate(_decision, _context) {
    return true;
  }

  /**
   * Augments the routing decision and/or context. Must return a new RoutingDecision.
   *
   * @param {import('../types.js').RoutingDecision} decision
   * @param {import('../types.js').PaymentContext} context
   * @returns {import('../types.js').RoutingDecision}
   */
  decorate(_decision, _context) {
    throw new Error(`Decorator ${this.name} must implement decorate()`);
  }
}
