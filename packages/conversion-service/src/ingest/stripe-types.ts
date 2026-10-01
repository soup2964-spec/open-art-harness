/**
 * Minimal Stripe Event typing for the fields openart-signal reads. The payload itself is
 * validated against contracts' stripe-event.schema.json before mapping.
 */

export type StripeObject = Record<string, unknown>;

export interface StripeEvent {
  id: string;
  object: 'event';
  api_version: string | null;
  created: number;
  data: { object: StripeObject; previous_attributes?: StripeObject };
  livemode: boolean;
  pending_webhooks?: number;
  request?: { id: string | null; idempotency_key: string | null } | null;
  type: string;
}
