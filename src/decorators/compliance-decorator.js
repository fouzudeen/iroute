import { DecisionDecorator } from './decorator.js';

export class ComplianceDecorator extends DecisionDecorator {
  constructor(options = {}) {
    super('ComplianceDecorator', options);
    this.sanctionedCountries = new Set(options.sanctionedCountries || ['XX', 'YY']);
    this.highRiskThreshold = options.highRiskThreshold ?? 80;
    this.require3dsThreshold = options.require3dsThreshold ?? 70;
  }

  canDecorate(decision, context) {
    return decision.candidates.length > 0 || this._isBlocked(context);
  }

  decorate(decision, context) {
    const flags = [];
    const excluded = [...decision.excluded];
    let candidates = decision.candidates;

    if (this._isSanctioned(context)) {
      flags.push('SANCTIONED_COUNTRY');
      excluded.push(...candidates.map(c => ({ pspId: c.id, reason: 'sanctioned country' })));
      candidates = [];
    }

    if (this._isHighRisk(context)) {
      flags.push('HIGH_RISK');
    }

    if (this._requires3ds(context)) {
      flags.push('REQUIRES_3DS');
    }

    return {
      ...decision,
      candidates,
      excluded,
      provenance: {
        ...decision.provenance,
        complianceFlags: flags
      }
    };
  }

  _isBlocked(context) {
    return this._isSanctioned(context) || this._isHighRisk(context);
  }

  _isSanctioned(context) {
    return this.sanctionedCountries.has(context.country);
  }

  _isHighRisk(context) {
    return (context.customer?.riskScore ?? 0) >= this.highRiskThreshold;
  }

  _requires3ds(context) {
    return (context.customer?.riskScore ?? 0) >= this.require3dsThreshold;
  }
}
