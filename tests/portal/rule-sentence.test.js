import { test } from 'node:test';
import assert from 'node:assert';
import { ruleSentence } from '../../src/portal/formatters/rule-sentence.js';

test('formats simple equality', () => {
  const sentence = ruleSentence({
    condition: { operator: 'eq', field: 'currency', value: 'EUR' },
    actions: { providers: [{ id: 'psp-eu' }] }
  });
  assert.strictEqual(sentence, 'When currency is EUR, route to psp-eu.');
});

test('formats AND group', () => {
  const sentence = ruleSentence({
    condition: {
      operator: 'and',
      conditions: [
        { operator: 'eq', field: 'currency', value: 'EUR' },
        { operator: 'in', field: 'country', value: ['DE', 'FR'] }
      ]
    },
    actions: { providers: [{ id: 'psp-eu', weight: 100 }] }
  });
  assert.strictEqual(sentence, 'When currency is EUR AND country is one of DE, FR, route to psp-eu (100).');
});

test('formats OR group with parentheses', () => {
  const sentence = ruleSentence({
    condition: {
      operator: 'or',
      conditions: [
        { operator: 'eq', field: 'currency', value: 'EUR' },
        { operator: 'eq', field: 'currency', value: 'USD' }
      ]
    },
    actions: { providers: [{ id: 'psp-multi' }] }
  });
  assert.strictEqual(sentence, 'When (currency is EUR OR currency is USD), route to psp-multi.');
});

test('formats fallback', () => {
  const sentence = ruleSentence({
    condition: { operator: 'eq', field: 'currency', value: 'EUR' },
    actions: { providers: [{ id: 'psp-eu' }], fallback: { id: 'psp-fallback' } }
  });
  assert.strictEqual(sentence, 'When currency is EUR, route to psp-eu; fallback psp-fallback.');
});
