import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { server, initEngine, startServer } from '../src/server.js';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let srv;

before(async () => {
  await initEngine();
  srv = await startServer(PORT);
});

after(() => {
  srv.close();
});

function request(path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('health endpoints', async () => {
  const live = await request('/health/live', 'GET');
  assert.strictEqual(live.status, 200);

  const ready = await request('/health/ready', 'GET');
  assert.ok(ready.status === 200 || ready.status === 503);
});

test('POST /v1/route returns prioritized providers', async () => {
  const res = await request('/v1/route', 'POST', {
    paymentIntentId: 'pi-123',
    merchantId: 'm-123',
    amount: { value: 750, currency: 'EUR' },
    instrument: { type: 'card', network: 'visa', cardCountry: 'DE' },
    context: { mcc: '5812', customerCountry: 'DE' }
  }, { 'Content-Type': 'application/json' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.candidates[0].pspId, 'psp-premium-eu');
  assert.strictEqual(res.body.strategy, 'RuleBasedStrategy');
  assert.ok(res.body.routingDecisionId);
  assert.ok(res.body.ruleVersion);
});

test('POST /v1/route uses DirectBankStrategy for mapped BIN', async () => {
  const res = await request('/v1/route', 'POST', {
    paymentIntentId: 'pi-bin',
    merchantId: 'm-123',
    amount: { value: 100, currency: 'EUR' },
    instrument: { type: 'card', bin: '424242', network: 'visa', cardCountry: 'US' }
  }, { 'Content-Type': 'application/json' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.strategy, 'DirectBankStrategy');
  assert.strictEqual(res.body.candidates[0].pgspId, 'pgsp-chase-direct');
});

test('POST /v1/route rejects missing fields', async () => {
  const res = await request('/v1/route', 'POST', { merchantId: 'm-1' }, { 'Content-Type': 'application/json' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'INVALID_REQUEST');
});

test('POST /v1/route handles unknown rule version', async () => {
  const res = await request('/v1/route', 'POST', {
    paymentIntentId: 'pi-123',
    merchantId: 'm-123',
    amount: { value: 10, currency: 'EUR' }
  }, { 'Content-Type': 'application/json', 'X-Rule-Version': '99.99.99' });

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'RULE_VERSION_NOT_FOUND');
});
