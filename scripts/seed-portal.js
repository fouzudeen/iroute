import { SqliteRuleStore } from '../src/repository/sqlite-rule-store.js';

const dbUrl = process.env.RULE_STORE_DB_URL || './rules/portal-rules.db';
const store = new SqliteRuleStore({ url: dbUrl });

const eu = await store.createTree({
  treeKey: 'eu-cards',
  name: 'EU Card Payments',
  description: 'Routing rules for EU card payments',
  criteria: { region: 'EU', paymentMethod: 'card' }
});

const euPkg = await store.publishPackage(eu.id, '1.0.0', {
  version: '1.0.0',
  createdAt: new Date().toISOString(),
  description: 'Initial EU card rules',
  rules: [
    {
      id: 'high-value-eu',
      priority: 20,
      condition: {
        operator: 'and',
        conditions: [
          { operator: 'gte', field: 'amount', value: 500 },
          { operator: 'in', field: 'country', value: ['DE', 'FR', 'NL', 'BE', 'AT'] },
          { operator: 'in', field: 'cardBrand', value: ['visa', 'mastercard'] }
        ]
      },
      actions: {
        providers: [
          { id: 'psp-premium-eu', type: 'psp', weight: 100, slaMs: 800 },
          { id: 'pgsp-eu-backup', type: 'pgsp', weight: 50, slaMs: 1200 }
        ]
      }
    },
    {
      id: 'default-eu',
      priority: 0,
      condition: { operator: 'eq', field: 'currency', value: 'EUR' },
      actions: {
        providers: [{ id: 'psp-standard', type: 'psp', weight: 100, slaMs: 900 }]
      }
    }
  ]
}, { publish: true, createdBy: 'seed' });

await store.setActive(eu.id, '1.0.0', 'production', 'global', '', 'seed');

const us = await store.createTree({
  treeKey: 'us-wallets',
  name: 'US Wallet Payments',
  description: 'Routing rules for US wallet payments',
  criteria: { region: 'US', paymentMethod: 'wallet' }
});

await store.publishPackage(us.id, '1.0.0', {
  version: '1.0.0',
  createdAt: new Date().toISOString(),
  description: 'Initial US wallet rules',
  rules: [
    {
      id: 'default-us-wallet',
      priority: 0,
      condition: { operator: 'eq', field: 'country', value: 'US' },
      actions: {
        providers: [
          { id: 'wallet-primary', type: 'psp', weight: 100, slaMs: 600 },
          { id: 'wallet-fallback', type: 'psp', weight: 50, slaMs: 900 }
        ]
      }
    }
  ]
}, { publish: true, createdBy: 'seed' });

await store.setActive(us.id, '1.0.0', 'production', 'global', '', 'seed');

console.log(`Seeded portal database at ${dbUrl}:`);
console.log(`- EU Cards: ${euPkg.id} @ ${euPkg.version}`);
console.log('- US Wallets: published and activated');

store.close();
