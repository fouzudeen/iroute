import { DecisionTreeEvaluator } from '../rules/evaluator.js';
import { RoutingError, ValidationError } from '../errors/errors.js';

export class RoutingEngine {
  constructor({ loader, validator, normalizer, logger }) {
    this.loader = loader;
    this.validator = validator;
    this.normalizer = normalizer;
    this.logger = logger.child({ module: 'RoutingEngine' });
    this._evaluator = null;
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
    this._evaluator = new DecisionTreeEvaluator(pkg, this.logger);
    this.logger.info({ version: pkg.version }, 'Routing rules loaded');
    return this;
  }

  async route(paymentContext) {
    if (!this._evaluator) {
      throw new RoutingError('Engine not loaded. Call load() first.');
    }
    const ctx = this.normalizer.normalize(paymentContext);
    const result = this._evaluator.evaluate(ctx);
    this.logger.info({
      requestId: ctx.requestId,
      result
    }, 'Route evaluated');
    return result;
  }
}
