import { RoutingError } from '../errors/errors.js';

export class DecisionTreeEvaluator {
  constructor(rulePackage, logger) {
    this.version = rulePackage.version;
    this.rules = [...rulePackage.rules].sort((a, b) => b.priority - a.priority);
    this.logger = logger?.child ? logger.child({ module: 'DecisionTreeEvaluator' }) : logger;
  }

  evaluate(context) {
    const matched = [];
    for (const rule of this.rules) {
      if (this._match(rule.condition, context)) {
        matched.push({
          ruleId: rule.id,
          priority: rule.priority,
          providers: rule.actions.providers,
          fallback: rule.actions.fallback
        });
      }
    }

    const prioritized = this._prioritize(matched);
    return {
      version: this.version,
      requestId: context.requestId,
      matches: matched.length,
      prioritizedProviders: prioritized,
      appliedRules: matched.map(m => m.ruleId)
    };
  }

  _match(condition, ctx) {
    switch (condition.operator) {
      case 'and':
        return condition.conditions.every(c => this._match(c, ctx));
      case 'or':
        return condition.conditions.some(c => this._match(c, ctx));
      case 'not':
        return !condition.conditions.some(c => this._match(c, ctx));
      default:
        return this._compare(condition, ctx);
    }
  }

  _compare({ operator, field, value }, ctx) {
    const actual = this._resolveField(ctx, field);
    switch (operator) {
      case 'eq': return actual === value;
      case 'ne': return actual !== value;
      case 'gt': return actual > value;
      case 'gte': return actual >= value;
      case 'lt': return actual < value;
      case 'lte': return actual <= value;
      case 'in': return Array.isArray(value) && value.includes(actual);
      case 'notIn': return Array.isArray(value) && !value.includes(actual);
      case 'regex': {
        try {
          return new RegExp(value).test(String(actual));
        } catch {
          throw new RoutingError(`Invalid regex in rule condition: ${value}`);
        }
      }
      default:
        throw new RoutingError(`Unknown operator: ${operator}`);
    }
  }

  _resolveField(ctx, field) {
    return field.split('.').reduce((obj, key) => obj?.[key], ctx);
  }

  _prioritize(matched) {
    const scored = matched.flatMap(rule =>
      rule.providers.map(p => ({
        ...p,
        rulePriority: rule.priority,
        ruleId: rule.ruleId,
        score: (rule.priority * 1000) + (p.weight || 100)
      }))
    );
    return scored.sort((a, b) => b.score - a.score);
  }
}
