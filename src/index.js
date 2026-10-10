import { RoutingEngine } from './engine/routing-engine.js';
import { RuleLoader } from './rules/loader.js';
import { RuleValidator } from './rules/validator.js';
import { ContextNormalizer } from './context/context.js';
import { DirectBankStrategy } from './strategies/direct-bank-strategy.js';
import { StrategyRegistry } from './strategies/registry.js';
import { DecisionDecorator } from './decorators/decorator.js';
import { DecoratorRegistry } from './decorators/registry.js';
import { FallbackDecorator } from './decorators/fallback-decorator.js';
import { ComplianceDecorator } from './decorators/compliance-decorator.js';
import { CapacityScoringDecorator } from './decorators/scoring-decorator.js';
import { logger } from './config/logger.js';
import { createRoutingDecision, isRoutingDecision, RoutingDecisionType } from './types.js';

export {
  RoutingEngine,
  RuleLoader,
  RuleValidator,
  ContextNormalizer,
  DirectBankStrategy,
  StrategyRegistry,
  DecisionDecorator,
  DecoratorRegistry,
  FallbackDecorator,
  ComplianceDecorator,
  CapacityScoringDecorator,
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

  const decorators = [];

  if (options.enableFallback !== false) {
    decorators.push(new FallbackDecorator({ fallbackProvider: options.fallbackProvider }));
  }

  if (options.enableCompliance !== false) {
    decorators.push(new ComplianceDecorator({
      sanctionedCountries: options.sanctionedCountries,
      highRiskThreshold: options.highRiskThreshold,
      require3dsThreshold: options.require3dsThreshold
    }));
  }

  if (options.enableCapacityScoring !== false) {
    decorators.push(new CapacityScoringDecorator({
      retryPenalty: options.retryPenalty,
      promotionBonus: options.promotionBonus
    }));
  }

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

  return new RoutingEngine({ loader, validator, normalizer, logger, strategies, decorators });
}
