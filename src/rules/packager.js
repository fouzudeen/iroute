import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import semver from 'semver';

export class RulePackager {
  constructor({ outputDir = './dist' } = {}) {
    this.outputDir = outputDir;
  }

  async package(sourcePath, version, description = '') {
    const valid = semver.valid(version);
    if (!valid) {
      throw new Error(`Invalid semantic version: ${version}`);
    }

    const content = await readFile(sourcePath, 'utf-8');
    const pkg = JSON.parse(content);
    pkg.version = version;
    pkg.createdAt = new Date().toISOString();
    pkg.description = description;

    const serialized = JSON.stringify(pkg);
    pkg.checksum = createHash('sha256').update(serialized).digest('hex');

    const outFile = resolve(this.outputDir, `rules-${version}.json`);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, JSON.stringify(pkg, null, 2));

    const latestFile = resolve(this.outputDir, 'latest.json');
    await writeFile(latestFile, JSON.stringify(pkg, null, 2));

    return { version, checksum: pkg.checksum, path: outFile };
  }
}
