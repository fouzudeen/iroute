import { test } from 'node:test';
import assert from 'node:assert';
import { createEngine } from '../src/index.js';
import { RoutingError } from '../src/errors/errors.js';

test('engine routes EU high-value visa transaction', async () => {
  const engine = await createEngine({ basePath: './rules', enableDirectBank: false });
  await engine.load('1.2.0');

  const result = await engine.route({
    amount: 750,
    currency: 'EUR',
    country: 'DE',
    paymentMethod: 'card',
    cardBrand: 'visa'
  });

  assert.strictEqual(result.ruleVersion, '1.2.0');
  assert.ok(result.candidates.length > 0);
  assert.strictEqual(result.candidates[0].id, 'psp-premium-eu');
  assert.strictEqual(result.provenance.strategyName, 'RuleBasedStrategy');
});

test('engine refuses to route before load', async () => {
  const engine = await createEngine({ basePath: './rules' });
  await assert.rejects(
    () => engine.route({ amount: 100, currency: 'USD' }),
    RoutingError
  );
});

test('engine includes requestId in result', async () => {
  const engine = await createEngine({ basePath: './rules', enableDirectBank: false });
  await engine.load('latest');
  const result = await engine.route({ amount: 10, currency: 'EUR' });
  assert.ok(result.requestId);
});
