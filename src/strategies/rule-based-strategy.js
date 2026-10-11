import { RoutingStrategy } from './strategy.js';
import { DecisionTreeEvaluator } from '../rules/evaluator.js';
import { ForestEvaluator } from '../rules/forest-evaluator.js';
import { createRoutingDecision } from '../types.js';
import { randomUUID } from 'node:crypto';

export class RuleBasedStrategy extends RoutingStrategy {
  constructor(rulePackage, options = {}) {
    super('RuleBasedStrategy', options);
    this._rulePackage = rulePackage;
    this._logger = options.logger;
  }

  canRoute(_context) {
    // Rule-based strategy is the default fallback and can always route.
    return true;
  }

  updatePackage(rulePackage) {
    this._rulePackage = rulePackage;
  }

  route(context, { startedAt = Date.now() } = {}) {
    const raw = this._rulePackage.forest
      ? new ForestEvaluator({ trees: this._rulePackage.trees, logger: this._logger }).evaluate(context)
      : new DecisionTreeEvaluator(this._rulePackage, this._logger).evaluate(context);

    const candidates = raw.prioritizedProviders.map(p => ({
      id: p.id,
      type: p.type,
      weight: p.weight,
      slaMs: p.slaMs,
      score: p.score,
      ruleId: p.ruleId
    }));

    return createRoutingDecision({
      decisionId: randomUUID(),
      requestId: context.requestId,
      ruleVersion: raw.version,
      candidates,
      excluded: [],
      fallbackUsed: candidates.length === 0,
      provenance: {
        strategyName: this.name,
        strategyVersion: this._rulePackage.version,
        evaluatedAt: new Date().toISOString(),
        matchedRules: raw.appliedRules,
        contextFingerprint: this._fingerprint(context)
      },
      latencyMs: Date.now() - startedAt
    });
  }

  _fingerprint(context) {
    return {
      amount: context.amount,
      currency: context.currency,
      country: context.country,
      paymentMethod: context.paymentMethod,
      cardBrand: context.cardBrand,
      issuerBin: context.issuerBin,
      merchantId: context.merchant?.id,
      mcc: context.merchant?.mcc
    };
  }
}
