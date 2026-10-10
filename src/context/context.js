import { randomUUID } from 'node:crypto';

export class ContextNormalizer {
  normalize(raw) {
    return {
      requestId: raw.requestId || randomUUID(),
      amount: Number(raw.amount),
      currency: String(raw.currency).toUpperCase(),
      country: String(raw.country).toUpperCase(),
      paymentMethod: String(raw.paymentMethod).toLowerCase(),
      cardBrand: raw.cardBrand ? String(raw.cardBrand).toLowerCase() : undefined,
      issuerBin: raw.issuerBin ? String(raw.issuerBin) : undefined,
      customer: {
        id: raw.customer?.id,
        tier: raw.customer?.tier,
        riskScore: Number(raw.customer?.riskScore ?? 0)
      },
      merchant: {
        id: raw.merchant?.id,
        mcc: raw.merchant?.mcc
      },
      metadata: raw.metadata || {}
    };
  }
}
