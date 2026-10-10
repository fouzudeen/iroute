import { DecisionDecorator } from './decorator.js';

export class CapacityScoringDecorator extends DecisionDecorator {
  constructor(options = {}) {
    super('CapacityScoringDecorator', options);
    this.retryPenalty = options.retryPenalty ?? 25;
    this.promotionBonus = options.promotionBonus ?? 15;
  }

  canDecorate(decision) {
    return decision.candidates.length > 0;
  }

  decorate(decision, context) {
    const retryAttempt = Number(context.metadata?.retryAttempt ?? 0);
    const promotionCode = context.metadata?.promotionCode;

    const adjusted = decision.candidates.map((candidate, index) => {
      let delta = 0;
      const reasons = candidate.reason ? [candidate.reason] : [];

      if (retryAttempt > 0) {
        delta -= retryAttempt * this.retryPenalty;
        reasons.push(`retry-penalty:${retryAttempt}`);
      }

      if (promotionCode) {
        delta += this.promotionBonus;
        reasons.push(`promotion:${promotionCode}`);
      }

      return {
        ...candidate,
        score: (candidate.score ?? 0) + delta,
        originalPriority: index + 1,
        reasons
      };
    });

    // Re-sort by adjusted score descending, preserving original priority as tie-breaker.
    adjusted.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.originalPriority || 0) - (b.originalPriority || 0);
    });

    return {
      ...decision,
      candidates: adjusted,
      provenance: {
        ...decision.provenance,
        scoringAdjustments: {
          retryPenalty: retryAttempt > 0 ? retryAttempt * this.retryPenalty : 0,
          promotionBonus: promotionCode ? this.promotionBonus : 0
        }
      }
    };
  }
}
