import { test } from 'node:test';
import assert from 'node:assert';
import { createEngine, isRoutingDecision, RoutingDecisionType } from '../src/index.js';
import { RuleBasedStrategy } from '../src/strategies/rule-based-strategy.js';
import { DirectBankStrategy } from '../src/strategies/direct-bank-strategy.js';
import { StrategyRegistry } from '../src/strategies/registry.js';
import { createRoutingDecision } from '../src/types.js';

test('RoutingDecision is a typed object with provenance', () => {
  const decision = createRoutingDecision({
    decisionId: 'd-1',
    requestId: 'r-1',
    ruleVersion: '1.0.0',
    candidates: [{ id: 'psp-a', type: 'psp' }],
    provenance: {
      strategyName: 'TestStrategy',
      strategyVersion: '1.0.0',
      evaluatedAt: new Date().toISOString()
    },
    latencyMs: 5
  });

  assert.strictEqual(decision.__type, RoutingDecisionType);
  assert.strictEqual(isRoutingDecision(decision), true);
  assert.strictEqual(decision.provenance.strategyName, 'TestStrategy');
});

test('DirectBankStrategy selects when issuerBin is mapped', async () => {
  const strategy = new DirectBankStrategy({ mappingPath: './rules/bin-mapping.json', version: '1.0.0' });
  await strategy.load();

  assert.strictEqual(strategy.canRoute({ issuerBin: '424242' }), true);
  assert.strictEqual(strategy.canRoute({ issuerBin: '999999' }), false);
});

test('DirectBankStrategy returns typed RoutingDecision', async () => {
  const strategy = new DirectBankStrategy({ mappingPath: './rules/bin-mapping.json', version: '1.0.0' });
  await strategy.load();

  const decision = strategy.route({ requestId: 'r-1', issuerBin: '424242' });
  assert.strictEqual(isRoutingDecision(decision), true);
  assert.strictEqual(decision.ruleVersion, 'bin:1.0.0');
  assert.strictEqual(decision.candidates[0].id, 'pgsp-chase-direct');
  assert.strictEqual(decision.provenance.strategyName, 'DirectBankStrategy');
  assert.deepStrictEqual(decision.provenance.matchedRules, ['bin:424242']);
});

test('StrategyRegistry selects first mutually exclusive strategy', async () => {
  const registry = new StrategyRegistry({ child: () => ({ info: () => {}, debug: () => {} }) });
  const directBank = new DirectBankStrategy({ mappingPath: './rules/bin-mapping.json', version: '1.0.0' });
  await directBank.load();

  registry.register(directBank);
  registry.register(new RuleBasedStrategy({ version: '1.0.0', rules: [] }, { logger: { child: () => ({}) } }));

  const direct = registry.select({ issuerBin: '424242' });
  assert.strictEqual(direct.name, 'DirectBankStrategy');

  const ruleBased = registry.select({ issuerBin: '999999' });
  assert.strictEqual(ruleBased.name, 'RuleBasedStrategy');
});

test('Engine uses DirectBankStrategy for mapped BIN and RuleBasedStrategy otherwise', async () => {
  const engine = await createEngine({ basePath: './rules', binMappingPath: './rules/bin-mapping.json' });
  await engine.load('latest');

  const direct = await engine.route({
    paymentIntentId: 'pi-direct',
    merchantId: 'm-1',
    amount: 100,
    currency: 'EUR',
    issuerBin: '424242'
  });
  assert.strictEqual(isRoutingDecision(direct), true);
  assert.strictEqual(direct.provenance.strategyName, 'DirectBankStrategy');

  const ruleBased = await engine.route({
    paymentIntentId: 'pi-rule',
    merchantId: 'm-1',
    amount: 750,
    currency: 'EUR',
    country: 'DE',
    paymentMethod: 'card',
    cardBrand: 'visa',
    issuerBin: '999999'
  });
  assert.strictEqual(isRoutingDecision(ruleBased), true);
  assert.strictEqual(ruleBased.provenance.strategyName, 'RuleBasedStrategy');
});

test('StrategyRegistry.replace swaps the same-named strategy in place, preserving order', () => {
  const logger = { child: () => ({ info: () => {}, debug: () => {} }) };
  const registry = new StrategyRegistry(logger);

  const directBank = { name: 'DirectBankStrategy', canRoute: () => false, route: () => 'direct' };
  const firstRuleBased = { name: 'RuleBasedStrategy', canRoute: () => true, route: () => 'v1' };
  registry.register(directBank);
  registry.register(firstRuleBased);

  const secondRuleBased = { name: 'RuleBasedStrategy', canRoute: () => true, route: () => 'v2' };
  registry.replace(secondRuleBased);

  // Position (and therefore precedence) is unchanged; only the instance is swapped.
  assert.deepStrictEqual(registry.list(), ['DirectBankStrategy', 'RuleBasedStrategy']);
  assert.strictEqual(registry.get('RuleBasedStrategy'), secondRuleBased);
  assert.strictEqual(registry.select({}).route(), 'v2');
});

test('StrategyRegistry.replace appends a strategy whose name is not registered', () => {
  const logger = { child: () => ({ info: () => {}, debug: () => {} }) };
  const registry = new StrategyRegistry(logger);

  registry.register({ name: 'Alpha', canRoute: () => true, route: () => 'a' });
  registry.replace({ name: 'Beta', canRoute: () => true, route: () => 'b' });

  assert.deepStrictEqual(registry.list(), ['Alpha', 'Beta']);
});

test('StrategyRegistry.replace rejects an invalid strategy', () => {
  const logger = { child: () => ({ info: () => {}, debug: () => {} }) };
  const registry = new StrategyRegistry(logger);

  assert.throws(() => registry.replace({ name: 'BadStrategy' }), /Invalid strategy/);
});

test('StrategyRegistry.all returns a copy that cannot mutate the registry', () => {
  const logger = { child: () => ({ info: () => {}, debug: () => {} }) };
  const registry = new StrategyRegistry(logger);
  const alpha = { name: 'Alpha', canRoute: () => true, route: () => 'a' };
  registry.register(alpha);

  const snapshot = registry.all();
  snapshot.push({ name: 'Injected', canRoute: () => true, route: () => 'x' });
  snapshot[0] = { name: 'Mutated', canRoute: () => true, route: () => 'x' };

  assert.deepStrictEqual(registry.list(), ['Alpha']);
  assert.strictEqual(registry.get('Alpha'), alpha);
});
