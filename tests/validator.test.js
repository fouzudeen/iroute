import { test } from 'node:test';
import assert from 'node:assert';
import { RuleValidator } from '../src/rules/validator.js';

const validPackage = {
  version: '1.0.0',
  createdAt: '2026-10-10T00:00:00.000Z',
  rules: [
    {
      id: 'test',
      priority: 1,
      condition: { operator: 'eq', field: 'currency', value: 'EUR' },
      actions: { providers: [{ id: 'psp-a', type: 'psp' }] }
    }
  ]
};

test('validator accepts a valid package', () => {
  const v = new RuleValidator();
  assert.strictEqual(v.validate(validPackage), true);
});

test('validator rejects a package missing version', () => {
  const v = new RuleValidator();
  const invalid = { ...validPackage, version: undefined };
  delete invalid.version;
  assert.strictEqual(v.validate(invalid), false);
  assert.ok(v.errors.length > 0);
});

test('validator rejects unknown operator', () => {
  const v = new RuleValidator();
  const invalid = JSON.parse(JSON.stringify(validPackage));
  invalid.rules[0].condition.operator = 'magic';
  assert.strictEqual(v.validate(invalid), false);
});
