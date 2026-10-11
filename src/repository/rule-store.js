/**
 * @typedef {Object} DecisionTreeInput
 * @property {string} treeKey
 * @property {string} name
 * @property {string} [description]
 * @property {Object} criteria
 *
 * @typedef {Object} DecisionTree
 * @property {string} id
 * @property {string} treeKey
 * @property {string} name
 * @property {string} description
 * @property {Object} criteria
 * @property {string|null} activeVersionId
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} RulePackageInput
 * @property {string} decisionTreeId
 * @property {string} version
 * @property {Object} rules
 * @property {string} [description]
 * @property {string} [createdBy]
 *
 * @typedef {Object} RulePackage
 * @property {string} id
 * @property {string} decisionTreeId
 * @property {string} version
 * @property {string} description
 * @property {Object} rules
 * @property {string} checksum
 * @property {string|null} createdBy
 * @property {string} createdAt
 * @property {string|null} publishedAt
 *
 * @typedef {Object} ActivationInput
 * @property {string} decisionTreeId
 * @property {string} rulePackageId
 * @property {string} environment
 * @property {string} [scope]
 * @property {string} [scopeValue]
 * @property {string} [activatedBy]
 *
 * @typedef {Object} AuditEntry
 * @property {string} [decisionTreeId]
 * @property {string} [rulePackageId]
 * @property {string} action
 * @property {string} [actor]
 * @property {Object} [payload]
 */

export class IRuleStore {
  // Trees
  async createTree(_tree) { throw new Error('Not implemented'); }
  async getTreeByKey(_treeKey) { throw new Error('Not implemented'); }
  async listTrees() { throw new Error('Not implemented'); }
  async findMatchingTrees(_context, _env, _scope, _scopeValue) { throw new Error('Not implemented'); }

  // Packages
  async publishPackage(_treeId, _version, _rulesJson, _meta) { throw new Error('Not implemented'); }
  async getPackageById(_id) { throw new Error('Not implemented'); }
  async getPackage(_treeId, _version) { throw new Error('Not implemented'); }
  async listPackages(_treeId) { throw new Error('Not implemented'); }
  async listDrafts(_treeId) { throw new Error('Not implemented'); }
  async deletePackage(_id) { throw new Error('Not implemented'); }
  async setPackagePublished(_id) { throw new Error('Not implemented'); }

  // Trees
  async updateTree(_treeId, _updates) { throw new Error('Not implemented'); }

  // Activations
  async setActive(_treeId, _version, _env, _scope, _scopeValue, _actor) { throw new Error('Not implemented'); }
  async getActivePackage(_treeId, _env, _scope, _scopeValue) { throw new Error('Not implemented'); }
  async rollback(_treeId, _env, _scope, _scopeValue) { throw new Error('Not implemented'); }

  // Audit
  async logAudit(_entry) { throw new Error('Not implemented'); }
}
