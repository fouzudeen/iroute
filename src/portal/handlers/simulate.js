import { DecisionTreeEvaluator } from '../../rules/evaluator.js';
import { ContextNormalizer } from '../../context/context.js';

const normalizer = new ContextNormalizer();

export async function simulateHandler(store, body, send) {
  const { treeKey, version, context } = body;
  if (!treeKey || !version) {
    return send(400, { code: 'INVALID_REQUEST', message: 'treeKey and version are required' });
  }

  const tree = await store.getTreeByKey(treeKey);
  if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });

  const pkg = await store.getPackage(tree.id, version);
  if (!pkg) return send(404, { code: 'VERSION_NOT_FOUND', message: version });

  const normalized = normalizer.normalize({
    requestId: 'portal-sim-' + Date.now(),
    ...context
  });

  const evaluator = new DecisionTreeEvaluator({ version: pkg.version, rules: pkg.rules.rules });
  const result = evaluator.evaluate(normalized);

  return send(200, {
    context: normalized,
    version: pkg.version,
    matches: result.matches,
    matchedRules: result.appliedRules,
    candidates: result.prioritizedProviders.map((p, i) => ({
      priority: i + 1,
      pspId: p.type === 'psp' ? p.id : null,
      pgspId: p.type === 'pgsp' ? p.id : null,
      score: p.score,
      reasons: [p.ruleId],
      estimatedLatencyMs: p.slaMs || null
    }))
  });
}
