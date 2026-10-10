import { RulePackager } from '../src/rules/packager.js';

const [,, sourcePath, version, description] = process.argv;

if (!sourcePath || !version) {
  console.error('Usage: node scripts/package-rules.js <source-path> <version> [description]');
  process.exit(1);
}

const packager = new RulePackager({ outputDir: './rules' });
const result = await packager.package(sourcePath, version, description || '');
console.log(JSON.stringify(result, null, 2));
