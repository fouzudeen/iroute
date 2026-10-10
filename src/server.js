import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createEngine } from './index.js';
import { logger } from './config/logger.js';
import { RoutingError, ValidationError, RuleNotFoundError } from './errors/errors.js';

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const RULE_STORE_PATH = process.env.RULE_STORE_PATH || './rules';
const RULE_STORE_URL = process.env.RULE_STORE_URL || undefined;

let engine = null;
let ready = false;

export async function initEngine() {
  engine = await createEngine({ basePath: RULE_STORE_PATH, remoteUrl: RULE_STORE_URL });
  await engine.load('latest');
  ready = true;
  logger.info({ version: engine._evaluator.version }, 'Routing engine ready');
  return engine;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(err) {
  if (err instanceof ValidationError) {
    return { status: 400, body: { code: 'INVALID_RULE_PACKAGE', message: err.message, details: err.details } };
  }
  if (err instanceof RuleNotFoundError) {
    return { status: 404, body: { code: 'RULE_VERSION_NOT_FOUND', message: err.message } };
  }
  if (err.code === 'RULE_STORE_UNAVAILABLE' || err.message?.includes('store')) {
    return { status: 503, body: { code: 'RULE_STORE_UNAVAILABLE', message: err.message } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: err.message } };
}

async function handleRoute(req, res) {
  const started = Date.now();
  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return send(res, 400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON' });
  }

  const required = ['paymentIntentId', 'merchantId', 'amount'];
  const missing = required.filter(f => payload[f] == null);
  if (missing.length) {
    return send(res, 400, { code: 'INVALID_REQUEST', message: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!payload.amount.value || !payload.amount.currency) {
    return send(res, 400, { code: 'INVALID_REQUEST', message: 'amount.value and amount.currency are required' });
  }

  try {
    const version = req.headers['x-rule-version'];
    if (version && engine._evaluator?.version !== version) {
      // Per-request version pinning: load the requested version into a fresh engine
      const pinned = await createEngine({ basePath: RULE_STORE_PATH, remoteUrl: RULE_STORE_URL });
      await pinned.load(version);
      const result = await pinned.route(buildContext(payload));
      return send(res, 200, formatResponse(result, started, payload.options));
    }

    const result = await engine.route(buildContext(payload));
    return send(res, 200, formatResponse(result, started, payload.options));
  } catch (err) {
    logger.error({ err, paymentIntentId: payload.paymentIntentId }, 'Routing failed');
    const { status, body } = errorResponse(err);
    return send(res, status, body);
  }
}

function buildContext(payload) {
  return {
    requestId: payload.paymentIntentId || randomUUID(),
    amount: payload.amount.value,
    currency: payload.amount.currency,
    country: payload.context?.customerCountry || payload.instrument?.cardCountry,
    paymentMethod: payload.instrument?.type || 'card',
    cardBrand: payload.instrument?.network,
    issuerBin: payload.instrument?.bin,
    customer: {
      id: payload.customerId,
      riskScore: payload.context?.riskScore
    },
    merchant: {
      id: payload.merchantId,
      mcc: payload.context?.mcc
    },
    metadata: payload.context?.metadata || {}
  };
}

function formatResponse(result, started, options = {}) {
  const candidates = result.prioritizedProviders.slice(0, options.maxCandidates || 5).map(p => ({
    pspId: p.id,
    pgspId: p.type === 'pgsp' ? p.id : null,
    priority: p.priority || 1,
    score: p.score,
    reasons: [p.ruleId],
    estimatedLatencyMs: p.slaMs || null,
    estimatedCostBps: null
  }));

  const excluded = [];

  const response = {
    routingDecisionId: randomUUID(),
    ruleVersion: result.version,
    candidates,
    excluded,
    fallbackUsed: candidates.length === 0,
    decidedAt: new Date().toISOString()
  };

  if (options.includeExplanation) {
    response.explanation = {
      contextSnapshot: {},
      matchedRules: result.appliedRules,
      tieBreakers: []
    };
  }

  response.latencyMs = Date.now() - started;
  return response;
}

export const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health/live') {
    return send(res, 200, { status: 'alive' });
  }

  if (req.method === 'GET' && url.pathname === '/health/ready') {
    return send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not ready' });
  }

  if (req.method === 'POST' && url.pathname === '/v1/route') {
    return handleRoute(req, res);
  }

  return send(res, 404, { code: 'NOT_FOUND', message: `Unknown route ${req.method} ${url.pathname}` });
});

export function startServer(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info({ port }, 'Routing server listening');
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initEngine()
    .then(() => startServer(DEFAULT_PORT))
    .catch(err => {
      logger.error({ err }, 'Failed to initialize routing engine');
      ready = false;
    });
}
