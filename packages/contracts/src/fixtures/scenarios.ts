/**
 * Hand-specified SYNTHETIC scenarios used for the source fixtures and the golden
 * canonical rows. Every id, email and uid here is invented (uids start "Synth",
 * emails use the reserved .test TLD). Real OpenArt identifiers appear only where
 * they are public catalog/config ids (price/product ids, pixel ids, form ids).
 */

export const SCENARIO_USERS = {
  /** Starter monthly: first purchase, two renewals, refund of the 2nd renewal, cancel. */
  u01: { uid: 'SynthU01StarterMonA1', email: 'synth.u01@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000001' },
  /** Wonder annual buyer. */
  u02: { uid: 'SynthU02WonderYearB2', email: 'synth.u02@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000002' },
  /** Plus monthly: buys one add-on pack, then upgrades to Pro. */
  u03: { uid: 'SynthU03PlusAddUpgC3', email: 'synth.u03@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000003' },
  /** Pro monthly with a chargeback. */
  u04: { uid: 'SynthU04ChargebackD4', email: 'synth.u04@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000004' },
  /** Free user: trial credits, first generation, one-time pack. */
  u05: { uid: 'SynthU05FreeTrialE5x', email: 'synth.u05@example.test', deviceId: '5b0c8f2e-1d4a-4c3b-9e7f-000000000005' },
} as const;

/** ISO string -> Stripe unix seconds. */
export function sec(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** ISO string -> epoch ms. */
export function ms(iso: string): number {
  return Date.parse(iso);
}

export const U01 = {
  checkoutSession: 'cs_live_a1SynthU01Checkout0001',
  subscription: 'sub_1SynthU01Starter000001',
  item: 'si_SynthU01ItemPlan01',
  invoices: ['in_1SynthU01Inv0001First', 'in_1SynthU01Inv0002Cycle', 'in_1SynthU01Inv0003Cycle'],
  paymentIntents: ['pi_3SynthU01Pi0001', 'pi_3SynthU01Pi0002', 'pi_3SynthU01Pi0003'],
  charges: ['ch_3SynthU01Chg0001', 'ch_3SynthU01Chg0002', 'ch_3SynthU01Chg0003'],
  periods: ['2026-06-03T17:04:11Z', '2026-07-03T17:04:11Z', '2026-08-03T17:04:11Z', '2026-09-03T17:04:11Z'],
  refundedAt: '2026-08-05T09:12:40Z',
  cancelRequestedAt: '2026-08-05T09:13:02Z',
  checkoutStartedAt: '2026-06-03T17:02:30Z',
} as const;

export const U02 = {
  checkoutSession: 'cs_live_a1SynthU02Checkout0001',
  subscription: 'sub_1SynthU02Wonder0000001',
  item: 'si_SynthU02ItemPlan01',
  invoice: 'in_1SynthU02Inv0001First',
  paymentIntent: 'pi_3SynthU02Pi0001',
  purchasedAt: '2026-06-10T21:30:00Z',
  periodEnd: '2027-06-10T21:30:00Z',
} as const;

export const U03 = {
  checkoutSession: 'cs_live_a1SynthU03Checkout0001',
  subscription: 'sub_1SynthU03Plus00000001',
  planItem: 'si_SynthU03ItemPlan01',
  packItem: 'si_SynthU03ItemPack01',
  invoices: { first: 'in_1SynthU03Inv0001First', addOn: 'in_1SynthU03Inv0002AddOn', upgrade: 'in_1SynthU03Inv0003Upgrade' },
  paymentIntents: { first: 'pi_3SynthU03Pi0001', addOn: 'pi_3SynthU03Pi0002', upgrade: 'pi_3SynthU03Pi0003' },
  purchasedAt: '2026-06-15T12:00:00Z',
  periodEnd: '2026-07-15T12:00:00Z',
  addOnAt: '2026-06-25T12:00:00Z',
  upgradeAt: '2026-07-05T12:00:00Z',
  /** 20 of 30 days remain at the add-on: 1500 x 20/30. */
  addOnProrationMinor: 1000,
  /** 10 of 30 days remain at the upgrade: -3400 x 10/30 and +5600 x 10/30 (Stripe rounds per line). */
  unusedPlusMinor: -1133,
  remainingProMinor: 1867,
} as const;

export const U04 = {
  checkoutSession: 'cs_live_a1SynthU04Checkout0001',
  subscription: 'sub_1SynthU04Pro000000001',
  item: 'si_SynthU04ItemPlan01',
  invoice: 'in_1SynthU04Inv0001First',
  paymentIntent: 'pi_3SynthU04Pi0001',
  charge: 'ch_3SynthU04Chg0001',
  dispute: 'dp_1SynthU04Dispute0001',
  purchasedAt: '2026-07-20T08:00:00Z',
  periodEnd: '2026-08-20T08:00:00Z',
  disputedAt: '2026-08-02T10:00:00Z',
} as const;

export const U05 = {
  signupAt: '2026-07-01T10:00:00Z',
  firstGenerationAt: '2026-07-01T10:05:00Z',
  checkoutSession: 'cs_live_a1SynthU05Pack00000001',
  paymentIntent: 'pi_3SynthU05Pi0001',
  packPurchasedAt: '2026-07-05T10:00:00Z',
} as const;

export const HUBSPOT_LEADS = {
  adClick: { conversionId: '6f1d2c3b-0000-4000-8000-00000000a001', submittedAt: '2026-09-18T16:20:00Z', contactId: 90000000001 },
  organic: { conversionId: '6f1d2c3b-0000-4000-8000-00000000a002', submittedAt: '2026-09-20T09:45:00Z', contactId: 90000000002 },
  sqlAt: '2026-09-24T15:00:00Z',
  mqlAt: '2026-09-19T11:00:00Z',
} as const;
