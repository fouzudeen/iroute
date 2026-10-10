import { RoutingEngine } from './engine/routing-engine.js';
import { RuleLoader } from './rules/loader.js';
import { RuleValidator } from './rules/validator.js';
import { ContextNormalizer } from './context/context.js';
import { logger } from './config/logger.js';

export {
  RoutingEngine,
  RuleLoader,
  RuleValidator,
  ContextNormalizer,
  logger
};

export async function createEngine(options = {}) {
  const loader = new RuleLoader(options);
  const validator = new RuleValidator();
  const normalizer = new ContextNormalizer();
  return new RoutingEngine({ loader, validator, normalizer, logger });
}
