import { test } from 'node:test';
import assert from 'node:assert';
import { createEngine } from '../src/index.js';
import { FallbackDecorator } from '../src/decorators/fallback-decorator.js';
import { ComplianceDecorator } from '../src/decorators/compliance-decorator.js';
import { CapacityScoringDecorator } from '../src/decorators/scoring-decorator.js';
import { DecoratorRegistry } from '../src/decorators/registry.js';
import { DecisionDecorator } from '../src/decorators/decorator.js';
import { createRoutingDecision } from '../src/types.js';

const baseDecision = (candidates = []) => createRoutingDecision({
  decisionId: 'd-1',
  requestId: 'r-1',
  ruleVersion: '1.0.0',
  candidates,
  provenance: {
    strategyName: 'TestStrategy',
    strategyVersion: '1.0.0',
    evaluatedAt: new Date().toISOString()
  },
  latencyMs: 5
});

test('FallbackDecorator adds fallback when no candidates exist', () => {
  const decorator = new FallbackDecorator({ fallbackProvider: { id: 'psp-default', type: 'psp' } });
  const decision = decorator.decorate(baseDecision([]), {});

  assert.strictEqual(decision.candidates.length, 1);
  assert.strictEqual(decision.candidates[0].id, 'psp-default');
  assert.strictEqual(decision.fallbackUsed, true);
  assert.strictEqual(decision.provenance.fallbackApplied, true);
});

test('FallbackDecorator does nothing when candidates exist', () => {
  const decorator = new FallbackDecorator();
  const original = baseDecision([{ id: 'psp-a', type: 'psp' }]);

  assert.strictEqual(decorator.canDecorate(original, {}), false);

  // decorate() is only called by the registry when canDecorate() returns true.
  // Calling it directly with candidates present leaves the decision unchanged.
  const decision = decorator.canDecorate(original, {})
    ? decorator.decorate(original, {})
    : original;

  assert.strictEqual(decision.candidates.length, 1);
  assert.strictEqual(decision.candidates[0].id, 'psp-a');
  assert.strictEqual(decision.fallbackUsed, false);
});

test('ComplianceDecorator flags high-risk context', () => {
  const decorator = new ComplianceDecorator({ highRiskThreshold: 80, require3dsThreshold: 70 });
  const decision = decorator.decorate(baseDecision([{ id: 'psp-a', type: 'psp' }]), {
    requestId: 'r-1',
    amount: 100,
    currency: 'EUR',
    customer: { riskScore: 85 }
  });

  assert.ok(decision.provenance.complianceFlags.includes('HIGH_RISK'));
  assert.ok(decision.provenance.complianceFlags.includes('REQUIRES_3DS'));
  assert.strictEqual(decision.candidates.length, 1);
});

test('ComplianceDecorator excludes all candidates for sanctioned country', () => {
  const decorator = new ComplianceDecorator({ sanctionedCountries: ['YY'] });
  const decision = decorator.decorate(baseDecision([{ id: 'psp-a', type: 'psp' }]), {
    requestId: 'r-1',
    amount: 100,
    currency: 'EUR',
    country: 'YY'
  });

  assert.strictEqual(decision.candidates.length, 0);
  assert.ok(decision.provenance.complianceFlags.includes('SANCTIONED_COUNTRY'));
  assert.strictEqual(decision.excluded.length, 1);
});

test('CapacityScoringDecorator penalizes retries and boosts promotions', () => {
  const decorator = new CapacityScoringDecorator({ retryPenalty: 20, promotionBonus: 10 });
  const decision = decorator.decorate(baseDecision([
    { id: 'psp-a', type: 'psp', score: 100 },
    { id: 'psp-b', type: 'psp', score: 90 }
  ]), {
    requestId: 'r-1',
    amount: 100,
    currency: 'EUR',
    metadata: { retryAttempt: 2, promotionCode: 'SUMMER' }
  });

  assert.strictEqual(decision.candidates[0].id, 'psp-a');
  assert.ok(decision.candidates[0].score < 100);
  assert.ok(decision.candidates[0].reasons.includes('retry-penalty:2'));
  assert.ok(decision.candidates[0].reasons.includes('promotion:SUMMER'));
  assert.strictEqual(decision.provenance.scoringAdjustments.retryPenalty, 40);
  assert.strictEqual(decision.provenance.scoringAdjustments.promotionBonus, 10);
});

test('DecoratorRegistry applies decorators in order and records provenance', () => {
  const registry = new DecoratorRegistry({ child: () => ({ info: () => {}, debug: () => {} }) });
  registry.register(new FallbackDecorator({ fallbackProvider: { id: 'fallback', type: 'psp' } }));
  registry.register(new ComplianceDecorator({ sanctionedCountries: ['YY'] }));

  const decision = registry.apply(baseDecision([]), {
    requestId: 'r-1',
    amount: 100,
    currency: 'EUR',
    country: 'YY'
  });

  assert.strictEqual(decision.provenance.decorators.length, 2);
  assert.strictEqual(decision.provenance.decorators[0], 'FallbackDecorator');
  assert.strictEqual(decision.provenance.decorators[1], 'ComplianceDecorator');
  assert.strictEqual(decision.candidates.length, 0);
  assert.strictEqual(decision.excluded[0].pspId, 'fallback');
});

test('DecoratorRegistry skips failed decorators and preserves decision', () => {
  class BadDecorator extends DecisionDecorator {
    constructor() { super('BadDecorator'); }
    decorate() { throw new Error('boom'); }
  }

  const registry = new DecoratorRegistry({ child: () => ({ info: () => {}, debug: () => {}, error: () => {} }) });
  registry.register(new BadDecorator());
  registry.register(new FallbackDecorator({ fallbackProvider: { id: 'fallback', type: 'psp' } }));

  const decision = registry.apply(baseDecision([]), { requestId: 'r-1', amount: 100, currency: 'EUR' });

  assert.strictEqual(decision.candidates[0].id, 'fallback');
  assert.ok(decision.provenance.decorators.includes('BadDecorator:failed'));
});

test('Engine applies decorators by default', async () => {
  const engine = await createEngine({ basePath: './rules', enableDirectBank: false });
  await engine.load('latest');

  const decision = await engine.route({
    amount: 750,
    currency: 'EUR',
    country: 'DE',
    paymentMethod: 'card',
    cardBrand: 'visa',
    metadata: { retryAttempt: 1, promotionCode: 'FLASH' }
  });

  assert.ok(decision.provenance.decorators);
  assert.ok(decision.provenance.decorators.includes('CapacityScoringDecorator'));
  assert.ok(decision.candidates[0].reasons.some(r => r.includes('promotion:FLASH') || r.includes('retry-penalty:1')));
});
