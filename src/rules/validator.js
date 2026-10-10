import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ruleSchema = JSON.parse(readFileSync(join(__dirname, 'schema.json'), 'utf-8'));

export class RuleValidator {
  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(this.ajv);
    this.validate = this.ajv.compile(ruleSchema);
  }

  get errors() {
    return this.validate.errors;
  }
}
