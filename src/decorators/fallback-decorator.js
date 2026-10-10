import { DecisionDecorator } from './decorator.js';

const DEFAULT_FALLBACK = { id: 'psp-fallback', type: 'psp', weight: 0, slaMs: 2000 };

export class FallbackDecorator extends DecisionDecorator {
  constructor(options = {}) {
    super('FallbackDecorator', options);
    this.fallbackProvider = options.fallbackProvider || DEFAULT_FALLBACK;
  }

  canDecorate(decision) {
    return decision.candidates.length === 0;
  }

  decorate(decision) {
    return {
      ...decision,
      candidates: [{ ...this.fallbackProvider, score: 0, reason: 'fallback' }],
      fallbackUsed: true,
      provenance: {
        ...decision.provenance,
        fallbackApplied: true
      }
    };
  }
}
