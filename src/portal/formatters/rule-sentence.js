const OP_WORDS = {
  eq: 'is',
  ne: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  notIn: 'is not one of',
  regex: 'matches'
};

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function formatCondition(condition) {
  if (!condition || !condition.operator) return 'true';
  if (condition.operator === 'and') {
    return condition.conditions.map(formatCondition).join(' AND ');
  }
  if (condition.operator === 'or') {
    return `(${condition.conditions.map(formatCondition).join(' OR ')})`;
  }
  if (condition.operator === 'not') {
    return `NOT (${condition.conditions.map(formatCondition).join(' AND ')})`;
  }
  const op = OP_WORDS[condition.operator] || condition.operator;
  return `${condition.field} ${op} ${formatValue(condition.value)}`;
}

function formatProvider(provider) {
  if (!provider) return 'none';
  const weight = provider.weight !== undefined ? ` (${provider.weight})` : '';
  return `${provider.id}${weight}`;
}

export function ruleSentence(rule) {
  if (!rule) return '';
  const when = formatCondition(rule.condition);
  const providers = (rule.actions?.providers || []).map(formatProvider).join(', ') || 'none';
  const fallback = rule.actions?.fallback ? `; fallback ${rule.actions.fallback.id}` : '';
  return `When ${when}, route to ${providers}${fallback}.`;
}

export { formatCondition, formatValue };
