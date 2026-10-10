export class RoutingStrategy {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
  }

  /**
   * Returns true if this strategy can handle the given payment context.
   * @param {import('../types.js').PaymentContext} _context
   * @returns {boolean}
   */
  canRoute(_context) {
    throw new Error('Strategy must implement canRoute()');
  }

  /**
   * Executes the strategy and returns a RoutingDecision.
   * @param {import('../types.js').PaymentContext} _context
   * @returns {import('../types.js').RoutingDecision}
   */
  route(_context) {
    throw new Error('Strategy must implement route()');
  }
}
