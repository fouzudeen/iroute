import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RoutingError, RuleNotFoundError } from '../errors/errors.js';

export class RuleLoader {
  constructor({ basePath = process.env.RULE_STORE_PATH || './rules', remoteUrl = process.env.RULE_STORE_URL } = {}) {
    this.basePath = basePath;
    this.remoteUrl = remoteUrl;
  }

  async load(version = 'latest') {
    if (this.remoteUrl) {
      return this._loadRemote(version);
    }
    return this._loadLocal(version);
  }

  async _loadLocal(version) {
    const file = version === 'latest'
      ? 'latest.json'
      : `rules-${version}.json`;
    const path = resolve(this.basePath, file);
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new RuleNotFoundError(version);
      }
      throw new RoutingError(`Failed to load rule package ${version}: ${err.message}`);
    }
  }

  async _loadRemote(version) {
    const url = new URL(`/rules/${version}`, this.remoteUrl).toString();
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        throw new RuleNotFoundError(version);
      }
      throw new RoutingError(`Remote rule store returned ${res.status} for ${version}`);
    }
    return res.json();
  }
}
