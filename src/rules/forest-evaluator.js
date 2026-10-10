import { RoutingError } from '../errors/errors.js';
import { DecisionTreeEvaluator } from './evaluator.js';

/**
 * Evaluates a forest (network) of decision trees.
 *
 * Keeps the existing DecisionTreeEvaluator untouched: each tree's rules are
 * loaded into a RulePackage shape and evaluated independently. Results are
 * merged, de-duplicated by provider id, and sorted by score with tie-breakers.
 */
export class ForestEvaluator {
  /**
   * @param {Object} options
   * @param {Array<{treeKey: string, criteria: Object, package: Object}>} options.trees
   * @param {import('pino').Logger} options.logger
   */
  constructor({ trees = [], logger } = {}) {
    this.trees = trees;
    this.logger = logger?.child ? logger.child({ module: 'ForestEvaluator' }) : logger;
  }

  /**
   * @param {Object} context Normalized payment context.
   * @returns {Object} Same shape as DecisionTreeEvaluator.evaluate() with merged providers.
   */
  evaluate(context) {
    if (this.trees.length === 0) {
      throw new RoutingError('No decision trees available in forest');
    }

    const perTree = [];
    for (const tree of this.trees) {
      if (!this._criteriaMatch(tree.criteria, context)) {
        continue;
      }

      try {
        const evaluator = new DecisionTreeEvaluator(tree.package, this.logger);
        const result = evaluator.evaluate(context);
        perTree.push({ treeKey: tree.treeKey, criteria: tree.criteria, result });
      } catch (err) {
        this.logger?.error({ err, treeKey: tree.treeKey }, 'Tree evaluation failed; skipping');
        perTree.push({
          treeKey: tree.treeKey,
          criteria: tree.criteria,
          result: {
            version: tree.package.version,
            requestId: context.requestId,
            matches: 0,
            prioritizedProviders: [],
            appliedRules: [],
            error: err.message
          }
        });
      }
    }

    if (perTree.length === 0) {
      throw new RoutingError('No decision trees matched the payment context');
    }

    const merged = this._merge(perTree);

    return {
      version: this._versionLabel(perTree),
      requestId: context.requestId,
      matches: merged.matches,
      prioritizedProviders: merged.providers,
      appliedRules: merged.appliedRules,
      treeResults: perTree.map(t => ({
        treeKey: t.treeKey,
        criteria: t.criteria,
        version: t.result.version,
        matches: t.result.matches,
        appliedRules: t.result.appliedRules
      }))
    };
  }

  _merge(perTree) {
    const seen = new Map();
    let totalMatches = 0;
    const appliedRules = [];

    for (const { treeKey, result } of perTree) {
      totalMatches += result.matches;
      appliedRules.push(...result.appliedRules);

      for (const p of result.prioritizedProviders) {
        const key = `${p.type}:${p.id}`;
        const existing = seen.get(key);
        const scored = { ...p, treeKey };
        if (!existing || this._isBetterCandidate(scored, existing)) {
          seen.set(key, scored);
        }
      }
    }

    const providers = Array.from(seen.values()).sort((a, b) => this._compareCandidates(b, a));

    return {
      matches: totalMatches,
      providers,
      appliedRules: [...new Set(appliedRules)]
    };
  }

  _isBetterCandidate(a, b) {
    return this._compareCandidates(a, b) > 0;
  }

  _compareCandidates(a, b) {
    const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    // Higher rule priority first.
    const priorityDiff = (a.rulePriority ?? 0) - (b.rulePriority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    // Lower SLA latency first.
    return (a.slaMs ?? Number.MAX_SAFE_INTEGER) - (b.slaMs ?? Number.MAX_SAFE_INTEGER);
  }

  _criteriaMatch(criteria, context) {
    for (const [key, expected] of Object.entries(criteria)) {
      const actual = context[key];
      if (actual === undefined || actual === null || actual === '') {
        return false;
      }
      if (Array.isArray(expected)) {
        if (!expected.includes(actual)) return false;
      } else if (actual !== expected) {
        return false;
      }
    }
    return true;
  }

  _versionLabel(perTree) {
    const labels = perTree.map(t => `${t.treeKey}@${t.result.version}`);
    return `forest:[${labels.join(',')}]`;
  }
}
