/**
 * @typedef {Object} PaymentContext
 * @property {string} requestId
 * @property {number} amount
 * @property {string} currency
 * @property {string} [country]
 * @property {string} paymentMethod
 * @property {string} [cardBrand]
 * @property {string} [issuerBin]
 * @property {Object} customer
 * @property {string} [customer.id]
 * @property {string} [customer.tier]
 * @property {number} [customer.riskScore]
 * @property {Object} merchant
 * @property {string} merchant.id
 * @property {string} [merchant.mcc]
 * @property {Object} metadata
 */

/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {'psp'|'pgsp'} type
 * @property {number} [weight]
 * @property {number} [slaMs]
 * @property {Object} [overrides]
 */

/**
 * @typedef {Object} RoutingProvenance
 * @property {string} strategyName
 * @property {string} strategyVersion
 * @property {string} evaluatedAt
 * @property {string[]} [matchedRules]
 * @property {Object} [contextFingerprint]
 * @property {string[]} [decorators]
 * @property {string[]} [complianceFlags]
 * @property {Object} [scoringAdjustments]
 * @property {number} [decoratorCount]
 */

/**
 * @typedef {Object} RoutingDecision
 * @property {'RoutingDecision'} __type
 * @property {string} decisionId
 * @property {string} requestId
 * @property {string} ruleVersion
 * @property {Provider[]} candidates
 * @property {Object[]} [excluded]
 * @property {boolean} fallbackUsed
 * @property {RoutingProvenance} provenance
 * @property {number} latencyMs
 * @property {string} decidedAt
 */

export const RoutingDecisionType = 'RoutingDecision';

/**
 * Factory for a typed RoutingDecision with provenance.
 *
 * @param {Object} params
 * @param {string} params.decisionId
 * @param {string} params.requestId
 * @param {string} params.ruleVersion
 * @param {Provider[]} params.candidates
 * @param {Object[]} [params.excluded]
 * @param {boolean} [params.fallbackUsed]
 * @param {RoutingProvenance} params.provenance
 * @param {number} params.latencyMs
 * @returns {RoutingDecision}
 */
export function createRoutingDecision(params) {
  return {
    __type: RoutingDecisionType,
    decisionId: params.decisionId,
    requestId: params.requestId,
    ruleVersion: params.ruleVersion,
    candidates: params.candidates,
    excluded: params.excluded ?? [],
    fallbackUsed: params.fallbackUsed ?? params.candidates.length === 0,
    provenance: params.provenance,
    latencyMs: params.latencyMs,
    decidedAt: new Date().toISOString()
  };
}

/**
 * @param {unknown} value
 * @returns {value is RoutingDecision}
 */
export function isRoutingDecision(value) {
  return value != null && typeof value === 'object' && value.__type === RoutingDecisionType;
}
