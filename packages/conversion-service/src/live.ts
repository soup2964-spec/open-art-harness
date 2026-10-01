/**
 * Live-mode credentials. Only used when CONVERSION_SERVICE_MODE=live and only for
 * LIVE_PLATFORMS. Secrets arrive as environment variables mounted from Secret Manager
 * (names in infra/conversion-service/secrets.yaml); values are never logged or written.
 */

import type { Platform } from '@openart-signal/contracts';
import { assertLiveSecret } from './config.js';
import type { ServiceConfig } from './config.js';
import type { AppliedAuth, AuthProvider } from './outbox/transport.js';
import { SECRETS_BY_AUTH } from './outbox/transport.js';
import type { AuthKind, PlatformRequest } from './platforms/types.js';
import { oauth1Header } from './platforms/x/oauth1.js';

export type SecretSource = (name: string) => string | undefined;

/** Auth kinds a platform needs in the current configuration. */
export function authKindsFor(platform: Platform, config: ServiceConfig): AuthKind[] {
  switch (platform) {
    case 'google_ads':
      return ['google_oauth'];
    case 'meta':
      return ['meta_access_token'];
    case 'tiktok':
      return ['tiktok_access_token'];
    case 'reddit':
      return ['reddit_bearer'];
    case 'linkedin':
      return ['linkedin_bearer'];
    case 'x':
      return ['x_oauth1'];
    case 'microsoft': {
      const kinds: AuthKind[] = config.microsoft.sendMode === 'offline_conversions' ? ['microsoft_ads_api'] : ['microsoft_uet_bearer'];
      if (config.microsoft.adjustments !== 'off' && !kinds.includes('microsoft_ads_api')) kinds.push('microsoft_ads_api');
      return kinds;
    }
    default: {
      const never: never = platform;
      throw new Error(`unknown platform ${String(never)}`);
    }
  }
}

/** Shortest plausible platform credential (the shortest real one, a Microsoft developer token, is longer). */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Fail fast at startup when a live platform lacks a credential, or holds a placeholder or an
 * implausibly short one. Errors name the variable, never the value.
 */
export function assertLiveCredentials(config: ServiceConfig, secrets: SecretSource): void {
  const missing: string[] = [];
  for (const platform of config.livePlatforms) {
    for (const kind of authKindsFor(platform, config)) {
      for (const name of SECRETS_BY_AUTH[kind]) {
        const value = secrets(name);
        if (!value) missing.push(`${platform}:${name}`);
        else assertLiveSecret(name, value, MIN_CREDENTIAL_LENGTH);
      }
    }
  }
  if (missing.length > 0) throw new Error(`live mode is missing credentials: ${missing.join(', ')}`);
}

export class EnvAuthProvider implements AuthProvider {
  constructor(
    private readonly secrets: SecretSource,
    /** Google access token for the Data Manager scope (service account via google-auth-library). */
    private readonly googleToken: () => Promise<string>,
  ) {}

  private need(name: string): string {
    const v = this.secrets(name);
    if (!v) throw new Error(`missing ${name}`);
    return v;
  }

  async apply(req: PlatformRequest): Promise<AppliedAuth> {
    const headers = { ...req.headers };
    switch (req.auth) {
      case 'google_oauth':
        return { url: req.url, headers: { ...headers, Authorization: `Bearer ${await this.googleToken()}` } };
      case 'meta_access_token':
        // The Graph API accepts an OAuth bearer header; a query-string token would end up in URL logs.
        return { url: req.url, headers: { ...headers, Authorization: `Bearer ${this.need('META_CAPI_ACCESS_TOKEN')}` } };
      case 'tiktok_access_token':
        return { url: req.url, headers: { ...headers, 'Access-Token': this.need('TIKTOK_EVENTS_ACCESS_TOKEN') } };
      case 'reddit_bearer':
        return { url: req.url, headers: { ...headers, Authorization: `Bearer ${this.need('REDDIT_CONVERSION_ACCESS_TOKEN')}` } };
      case 'linkedin_bearer':
        return { url: req.url, headers: { ...headers, Authorization: `Bearer ${this.need('LINKEDIN_ACCESS_TOKEN')}` } };
      case 'x_oauth1':
        return {
          url: req.url,
          headers: {
            ...headers,
            Authorization: oauth1Header(
              {
                consumerKey: this.need('X_CONSUMER_KEY'),
                consumerSecret: this.need('X_CONSUMER_SECRET'),
                token: this.need('X_ACCESS_TOKEN'),
                tokenSecret: this.need('X_ACCESS_TOKEN_SECRET'),
              },
              { method: req.method, url: req.url },
            ),
          },
        };
      case 'microsoft_uet_bearer':
        return { url: req.url, headers: { ...headers, Authorization: `Bearer ${this.need('MICROSOFT_UET_CAPI_TOKEN')}` } };
      case 'microsoft_ads_api':
        return {
          url: req.url,
          headers: { ...headers, Authorization: `Bearer ${this.need('MICROSOFT_ADS_ACCESS_TOKEN')}`, DeveloperToken: this.need('MICROSOFT_ADS_DEVELOPER_TOKEN') },
        };
      default: {
        const never: never = req.auth;
        throw new Error(`unknown auth kind ${String(never)}`);
      }
    }
  }
}

/** Live wiring only: OAuth access-token provider from Application Default Credentials. */
export async function googleAccessTokenProvider(scopes: string[]): Promise<() => Promise<string>> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('no Google access token');
    return token;
  };
}
