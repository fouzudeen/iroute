import { createEngine } from '../src/index.js';

const engine = await createEngine({ basePath: './rules' });
await engine.load('1.2.0');

const result = await engine.route({
  amount: 750,
  currency: 'EUR',
  country: 'DE',
  paymentMethod: 'card',
  cardBrand: 'visa',
  customer: { riskScore: 30 }
});

console.log(JSON.stringify(result, null, 2));
