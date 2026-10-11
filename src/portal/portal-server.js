import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { policiesHandler } from './handlers/policies.js';
import { simulateHandler } from './handlers/simulate.js';
import { auditHandler } from './handlers/audit.js';
import { adminChangesHandler } from './handlers/admin-changes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  const headers = corsHeaders(origin);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return true;
  }
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function contentTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname.replace('/portal/public/', '');
  const safePath = resolve(PUBLIC_DIR, requested);
  if (!safePath.startsWith(PUBLIC_DIR + '/') && safePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { code: 'FORBIDDEN', message: 'Invalid path' });
  }

  try {
    const s = await stat(safePath);
    if (!s.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': contentTypeFor(safePath) });
    createReadStream(safePath).pipe(res);
  } catch (err) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: err.message });
  }
}

function pagePath(name) {
  return resolve(PUBLIC_DIR, name);
}

async function servePage(res, fileName) {
  const file = pagePath(fileName);
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(file).pipe(res);
  } catch (err) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: err.message });
  }
}

export function portalRouter(store, options = {}) {
  const coordinator = options.coordinator || null;

  return async function handlePortal(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Handle CORS preflight and set headers on all portal responses.
    const corsPreflight = handleCors(req, res);
    if (corsPreflight) return;

    if (req.method === 'GET' && pathname.startsWith('/portal/public/')) {
      return serveStatic(req, res, pathname);
    }

    if (pathname === '/portal' || pathname === '/portal/') {
      return servePage(res, 'index.html');
    }

    if (pathname.startsWith('/portal/policy/')) {
      const rest = pathname.replace('/portal/policy/', '');
      if (rest.includes('/history')) {
        return servePage(res, 'history.html');
      }
      return servePage(res, 'policy.html');
    }

    if (pathname === '/portal/api/policies' && req.method === 'GET') {
      const result = await policiesHandler.list(store, { environment: options.environment }, sendJson.bind(null, res));
      return result;
    }
    if (pathname === '/portal/api/policies' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await policiesHandler.create(store, body, sendJson.bind(null, res));
      return result;
    }
    if (pathname === '/portal/api/simulate' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await simulateHandler(store, body, sendJson.bind(null, res));
      return result;
    }
    if (pathname === '/portal/api/audit' && req.method === 'GET') {
      return auditHandler(store, url.searchParams, sendJson.bind(null, res));
    }

    if (pathname.startsWith('/portal/api/admin/changes/')) {
      const rest = pathname.replace('/portal/api/admin/changes/', '');
      const [changeId, action] = rest.split('/');
      if (!changeId || !action) {
        return sendJson(res, 404, { code: 'NOT_FOUND', message: `Unknown admin route ${pathname}` });
      }
      if (!coordinator) {
        return sendJson(res, 503, { code: 'COORDINATOR_UNAVAILABLE', message: 'Valkey coordinator not configured' });
      }
      if (action === 'status' && req.method === 'GET') {
        return adminChangesHandler.status(coordinator, changeId, sendJson.bind(null, res));
      }
      if (action === 'force-commit' && req.method === 'POST') {
        return adminChangesHandler.forceCommit(coordinator, changeId, sendJson.bind(null, res));
      }
      if (action === 'abort' && req.method === 'POST') {
        const body = await readBody(req);
        return adminChangesHandler.abort(coordinator, changeId, body, sendJson.bind(null, res));
      }
      return sendJson(res, 404, { code: 'NOT_FOUND', message: `Unknown admin action ${action}` });
    }

    if (pathname.startsWith('/portal/api/policies/')) {
      const rest = pathname.replace('/portal/api/policies/', '');
      const [treeKey, action] = rest.split('/');

      if (!action) {
        if (req.method === 'GET') {
          const result = await policiesHandler.get(store, treeKey, sendJson.bind(null, res));
          return result;
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const result = await policiesHandler.update(store, treeKey, body, sendJson.bind(null, res));
          return result;
        }
      }

      if (action === 'draft' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await policiesHandler.saveDraft(store, treeKey, body, sendJson.bind(null, res));
        return result;
      }
      if (action === 'publish' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await policiesHandler.publish(store, treeKey, body, sendJson.bind(null, res));
        return result;
      }
      if (action === 'activate' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await policiesHandler.activate(store, treeKey, body, sendJson.bind(null, res));
        return result;
      }
      if (action === 'rollback' && req.method === 'POST') {
        const result = await policiesHandler.rollback(store, treeKey, sendJson.bind(null, res));
        return result;
      }
      if (action === 'history' && req.method === 'GET') {
        const result = await policiesHandler.history(store, treeKey, sendJson.bind(null, res));
        return result;
      }
    }

    return sendJson(res, 404, { code: 'NOT_FOUND', message: `Unknown portal route ${req.method} ${pathname}` });
  };
}
