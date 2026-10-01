/**
 * Google Ads Customer Match through the Data Manager API (the Google Ads API stopped
 * accepting new Customer Match adopters on 2026-04-01).
 *
 *   POST https://datamanager.googleapis.com/v1/audienceMembers:ingest   (scope .../auth/datamanager)
 *   POST https://datamanager.googleapis.com/v1/audienceMembers:remove
 *   body: destinations[{operatingAccount{accountType,accountId}, loginAccount?, productDestinationId}],
 *         audienceMembers[{userData{userIdentifiers[{emailAddress}|{phoneNumber}]}, consent}],
 *         encoding HEX, termsOfService{customerMatchTermsOfServiceStatus ACCEPTED} (ingest only),
 *         validateOnly
 * Limits: 10,000 members per request, 10 identifiers per member, one ID-data type per request;
 * requests are fast-fail (one bad record rejects the batch). Lists need >= 100 members to be
 * eligible for targeting. productDestinationId is the Customer Match list ("audience") id,
 * created once with userLists.create (uploadKeyTypes [CONTACT_ID]).
 */

import type { AudienceMember } from '@openart-signal/contracts';
import { chunk, type AudienceHttpRequest, type PlatformRequestInput, type PlatformRequestOutput } from './common.js';

export const GOOGLE_DATA_MANAGER_BASE = 'https://datamanager.googleapis.com/v1';
export const GOOGLE_LIMITS = { maxMembersPerRequest: 10_000, maxIdentifiersPerMember: 10, minListSize: 100 } as const;

export interface GoogleConfig {
  /** Google Ads customer id, digits only (not the AW- conversion id). */
  operatingAccountId: string;
  /** Manager account used to log in, when the operating account is accessed through one. */
  loginAccountId: string | null;
  /** list_name -> Customer Match audience id (productDestinationId). */
  userListIds: Record<string, string>;
  validateOnly: boolean;
  minListSize: number;
  maxMembersPerRequest: number;
}

function account(id: string) {
  if (!/^\d{10}$/.test(id)) throw new Error(`Google Ads account ids are 10 digits without dashes, got ${id}`);
  return { accountType: 'GOOGLE_ADS', accountId: id };
}

function userData(m: AudienceMember) {
  const ids: Array<{ emailAddress: string } | { phoneNumber: string }> = [];
  if (m.identifiers.email_sha256) ids.push({ emailAddress: m.identifiers.email_sha256 });
  if (m.identifiers.phone_sha256) ids.push({ phoneNumber: m.identifiers.phone_sha256 });
  if (ids.length === 0) throw new Error(`member ${m.user_id ?? '?'} has no Customer Match identifier`);
  if (ids.length > GOOGLE_LIMITS.maxIdentifiersPerMember) throw new Error('more than 10 identifiers for one audience member');
  return { userIdentifiers: ids };
}

export function googleRequests(o: PlatformRequestInput<GoogleConfig>): PlatformRequestOutput {
  const c = o.config;
  const listId = c.userListIds[o.listName] ?? `<CUSTOMER_MATCH_LIST_ID:${o.listName}>`;
  const destination = {
    operatingAccount: account(c.operatingAccountId),
    ...(c.loginAccountId ? { loginAccount: account(c.loginAccountId) } : {}),
    productDestinationId: listId,
  };
  const headers = { Authorization: 'Bearer <GOOGLE_OAUTH_ACCESS_TOKEN>', 'Content-Type': 'application/json' };
  const size = Math.min(c.maxMembersPerRequest, GOOGLE_LIMITS.maxMembersPerRequest);
  const requests: AudienceHttpRequest[] = [];
  let held: string | null = null;

  const addsAllowed = !(o.previousSize === 0 && o.sizeAfter < c.minListSize);
  if (!addsAllowed && o.adds.length > 0) {
    held = `new list would have ${o.sizeAfter} members < ${c.minListSize} (Customer Match targeting minimum); not uploaded yet`;
  }
  if (addsAllowed) {
    chunk(o.adds, size).forEach((batch, i) => {
      requests.push({
        id: `google_ads/${o.listName}/ingest-${i + 1}`,
        platform: 'google_ads',
        listName: o.listName,
        operation: 'add',
        method: 'POST',
        url: `${GOOGLE_DATA_MANAGER_BASE}/audienceMembers:ingest`,
        headers,
        json: {
          destinations: [destination],
          // Only users whose ad_user_data AND ad_personalization are granted reach this point.
          audienceMembers: batch.map((m) => ({ userData: userData(m), consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' } })),
          encoding: 'HEX',
          termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
          validateOnly: c.validateOnly,
        },
        members: batch.length,
      });
    });
  }
  // Removals always go out, whatever the list size: they are how consent withdrawals are honoured.
  chunk(o.removes, size).forEach((batch, i) => {
    requests.push({
      id: `google_ads/${o.listName}/remove-${i + 1}`,
      platform: 'google_ads',
      listName: o.listName,
      operation: 'remove',
      method: 'POST',
      url: `${GOOGLE_DATA_MANAGER_BASE}/audienceMembers:remove`,
      headers,
      json: { destinations: [destination], audienceMembers: batch.map((m) => ({ userData: userData(m) })), encoding: 'HEX', validateOnly: c.validateOnly },
      members: batch.length,
    });
  });
  return { requests, held };
}
