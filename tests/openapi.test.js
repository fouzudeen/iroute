import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { initEngine, startServer } from '../src/server.js';

const PORT = 3998;
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

test('GET /openapi.json returns valid OpenAPI spec', async () => {
  const res = await request('/openapi.json', 'GET');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.openapi, '3.1.0');
  assert.ok(res.body.paths['/v1/route']);
  assert.ok(res.body.paths['/health/live']);
  assert.ok(res.body.paths['/health/ready']);
});

test('GET /docs returns Swagger UI HTML', async () => {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/docs`, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          assert.strictEqual(res.statusCode, 200);
          assert.ok(res.headers['content-type'].includes('text/html'));
          assert.ok(data.includes('swagger-ui'));
          assert.ok(data.includes('/openapi.json'));
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
});

test('POST /v1/route response matches RoutingDecision schema', async () => {
  const res = await request('/v1/route', 'POST', {
    paymentIntentId: 'pi-123',
    merchantId: 'm-123',
    amount: { value: 750, currency: 'EUR' },
    instrument: { type: 'card', network: 'visa', cardCountry: 'DE' },
    context: { mcc: '5812', customerCountry: 'DE' }
  }, { 'Content-Type': 'application/json' });

  assert.strictEqual(res.status, 200);

  const decision = res.body;
  assert.ok(decision.routingDecisionId);
  assert.ok(decision.requestId);
  assert.ok(decision.ruleVersion);
  assert.ok(decision.strategy);
  assert.ok(Array.isArray(decision.candidates));
  assert.ok(Array.isArray(decision.excluded));
  assert.strictEqual(typeof decision.fallbackUsed, 'boolean');
  assert.strictEqual(typeof decision.latencyMs, 'number');
  assert.ok(decision.decidedAt);

  if (decision.candidates.length > 0) {
    const first = decision.candidates[0];
    assert.ok('pspId' in first);
    assert.ok('pgspId' in first);
    assert.ok('priority' in first);
    assert.ok('score' in first);
    assert.ok(Array.isArray(first.reasons));
  }
});

test('OpenAPI YAML file is present and parseable', async () => {
  const yaml = await readFile(new URL('../docs/openapi/openapi.yaml', import.meta.url), 'utf-8');
  assert.ok(yaml.includes('openapi: 3.1.0'));
  assert.ok(yaml.includes('operationId: routePayment'));
  assert.ok(yaml.includes('/v1/route'));
});
