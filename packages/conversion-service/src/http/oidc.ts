/**
 * OIDC bearer tokens from Google (Pub/Sub push subscriptions and Cloud Scheduler HTTP targets
 * both attach one for a configured service account). Verification is injected: production uses
 * google-auth-library's OAuth2Client.verifyIdToken (live wiring, fetches Google's public certs);
 * tests use a fake. The principal must be one of the allowed service-account emails.
 */

export interface TokenClaims {
  email?: string;
  email_verified?: boolean;
}

export type IdTokenVerifier = (token: string, audience: string) => Promise<TokenClaims>;

export type PushAuthResult = { ok: true; email: string } | { ok: false; reason: 'missing_token' | 'invalid_token' | 'unexpected_principal' };

export async function verifyPushToken(
  authorization: string | undefined,
  expected: { audience: string; allowedEmails: readonly string[] },
  verify: IdTokenVerifier,
): Promise<PushAuthResult> {
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!m) return { ok: false, reason: 'missing_token' };
  let claims: TokenClaims;
  try {
    claims = await verify(m[1]!, expected.audience);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!claims.email || claims.email_verified !== true || !expected.allowedEmails.includes(claims.email)) {
    return { ok: false, reason: 'unexpected_principal' };
  }
  return { ok: true, email: claims.email };
}

/** Live wiring only: google-auth-library verifier (dynamic import; never used by tests). */
export async function googleIdTokenVerifier(): Promise<IdTokenVerifier> {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client();
  return async (token, audience) => {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return { email: payload?.email, email_verified: payload?.email_verified };
  };
}
