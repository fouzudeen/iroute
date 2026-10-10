import { test } from 'node:test';
import assert from 'node:assert';
import { RuleLoader } from '../src/rules/loader.js';
import { RuleNotFoundError } from '../src/errors/errors.js';

test('loader loads latest package from local store', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  const pkg = await loader.load('latest');
  assert.ok(pkg.version);
  assert.ok(Array.isArray(pkg.rules));
});

test('loader loads specific version from local store', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  const pkg = await loader.load('1.2.0');
  assert.strictEqual(pkg.version, '1.2.0');
});

test('loader throws RuleNotFoundError for missing version', async () => {
  const loader = new RuleLoader({ basePath: './rules' });
  await assert.rejects(() => loader.load('99.99.99'), /Rule package 99.99.99 not found/);
});
