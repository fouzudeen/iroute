import { RuleValidator } from '../../rules/validator.js';

const validator = new RuleValidator();
const DEFAULT_ENV = 'production';

async function policySummary(tree, store, env) {
  const active = await store.getActivePackage(tree.id, env, 'global');
  const drafts = await store.listDrafts(tree.id);
  const versions = await store.listPackages(tree.id);
  return {
    treeKey: tree.treeKey,
    name: tree.name,
    description: tree.description,
    criteria: tree.criteria,
    liveVersion: active ? { version: active.version, publishedAt: active.publishedAt, createdBy: active.createdBy } : null,
    draftCount: drafts.length,
    versionCount: versions.length,
    updatedAt: tree.updatedAt,
    activeVersionId: tree.activeVersionId
  };
}

async function nextDraftVersion(store, treeId) {
  const versions = await store.listPackages(treeId);
  const max = versions.reduce((acc, v) => {
    const major = Number(v.version.split('.')[0]) || 0;
    return Math.max(acc, major);
  }, 0);
  return `${max + 1}.0.0-draft`;
}

export const policiesHandler = {
  async list(store, { environment = DEFAULT_ENV }, send) {
    if (!store) return send(503, { code: 'RULE_STORE_UNAVAILABLE', message: 'Portal requires RULE_STORE_DB_URL' });
    const trees = await store.listTrees();
    const summaries = await Promise.all(trees.map(t => policySummary(t, store, environment)));
    return send(200, { policies: summaries });
  },

  async get(store, treeKey, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    return send(200, { policy: await policySummary(tree, store, DEFAULT_ENV) });
  },

  async create(store, body, send) {
    const { treeKey, name, description = '', criteria = {} } = body;
    if (!treeKey || !name) {
      return send(400, { code: 'INVALID_REQUEST', message: 'treeKey and name are required' });
    }
    const tree = await store.createTree({ treeKey, name, description, criteria });
    return send(201, { policy: await policySummary(tree, store, DEFAULT_ENV) });
  },

  async update(store, treeKey, body, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    const updated = await store.updateTree(tree.id, {
      name: body.name,
      description: body.description,
      criteria: body.criteria
    });
    return send(200, { policy: await policySummary(updated, store, DEFAULT_ENV) });
  },

  async saveDraft(store, treeKey, body, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });

    const packageShape = {
      version: body.version || await nextDraftVersion(store, tree.id),
      createdAt: new Date().toISOString(),
      description: body.description || '',
      rules: body.rules || []
    };

    const valid = validator.validate(packageShape);
    if (!valid) {
      return send(422, { code: 'VALIDATION_ERROR', errors: validator.errors });
    }

    const pkg = await store.publishPackage(tree.id, packageShape.version, packageShape, {
      description: body.description,
      publish: false,
      createdBy: body.createdBy || 'portal'
    });
    return send(201, { version: pkg.version, checksum: pkg.checksum });
  },

  async publish(store, treeKey, body, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    const version = body.version;
    const env = body.environment || DEFAULT_ENV;
    const scope = body.scope || 'global';
    const scopeValue = body.scopeValue || '';
    const actor = body.createdBy || body.actor || 'portal';

    if (!version) {
      return send(400, { code: 'INVALID_REQUEST', message: 'version is required' });
    }

    const pkg = await store.getPackage(tree.id, version);
    if (!pkg) return send(404, { code: 'VERSION_NOT_FOUND', message: version });

    if (!pkg.publishedAt) {
      await store.setPackagePublished(pkg.id);
    }

    const active = await store.setActive(tree.id, version, env, scope, scopeValue, actor);
    return send(200, { policy: await policySummary(tree, store, env), activated: active.version });
  },

  async activate(store, treeKey, body, send) {
    return this.publish(store, treeKey, body, send);
  },

  async rollback(store, treeKey, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    const pkg = await store.rollback(tree.id, DEFAULT_ENV, 'global');
    if (!pkg) return send(422, { code: 'ROLLBACK_FAILED', message: 'No previous version' });
    return send(200, { policy: await policySummary(tree, store, DEFAULT_ENV), rolledBackTo: pkg.version });
  },

  async history(store, treeKey, send) {
    const tree = await store.getTreeByKey(treeKey);
    if (!tree) return send(404, { code: 'POLICY_NOT_FOUND', message: treeKey });
    const versions = await store.listPackages(tree.id);
    const active = await store.getActivePackage(tree.id, DEFAULT_ENV, 'global');
    return send(200, {
      policy: { treeKey: tree.treeKey, name: tree.name },
      versions: versions.map(v => ({
        version: v.version,
        description: v.description,
        publishedAt: v.publishedAt,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        isActive: active?.version === v.version
      }))
    });
  }
};
