const DEFAULT_LIMIT = 20;

export async function auditHandler(store, searchParams, send) {
  if (!store) return send(503, { code: 'RULE_STORE_UNAVAILABLE', message: 'Portal requires RULE_STORE_DB_URL' });

  const limit = Math.min(Number(searchParams.get('limit') || DEFAULT_LIMIT), 100);
  const treeKey = searchParams.get('treeKey') || null;

  const events = await store.listAudit(treeKey, limit);
  return send(200, { events });
}
