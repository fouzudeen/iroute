import { RoutingEngine } from './engine/routing-engine.js';
import { RuleLoader } from './rules/loader.js';
import { RuleValidator } from './rules/validator.js';
import { ContextNormalizer } from './context/context.js';
import { DirectBankStrategy } from './strategies/direct-bank-strategy.js';
import { StrategyRegistry } from './strategies/registry.js';
import { logger } from './config/logger.js';
import { createRoutingDecision, isRoutingDecision, RoutingDecisionType } from './types.js';

export {
  RoutingEngine,
  RuleLoader,
  RuleValidator,
  ContextNormalizer,
  DirectBankStrategy,
  StrategyRegistry,
  createRoutingDecision,
  isRoutingDecision,
  RoutingDecisionType,
  logger
};

export async function createEngine(options = {}) {
  const loader = new RuleLoader(options);
  const validator = new RuleValidator();
  const normalizer = new ContextNormalizer();
  const strategies = [];

  if (options.enableDirectBank !== false) {
    const directBank = new DirectBankStrategy({
      mappingPath: options.binMappingPath,
      version: options.binMappingVersion
    });
    await directBank.load().catch(err => {
      logger.warn({ err }, 'Direct bank mapping not available');
    });
    strategies.push(directBank);
  }

  return new RoutingEngine({ loader, validator, normalizer, logger, strategies });
}
