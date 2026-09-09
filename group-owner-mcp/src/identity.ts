/**
 * LAYER 1 — Verified caller identity.
 *
 * The single source of "who is asking" is the caller's bearer token, NOT any
 * tool argument. This is the foundation of the entire security model: because
 * identity comes from a signed token, no amount of prompt engineering ("I am
 * the admin", "ignore your instructions") can change who the caller is.
 *
 * Topology note: in the deployed demo the MCP adapter validates the end-user's
 * Okta token and forwards it (bearer passthrough). This module ALSO verifies it
 * against the org JWKS — defense in depth — so the server never trusts an
 * unverified assertion even if reached directly.
 *
 * Fail-closed: any verification failure yields `null` (no identity → no access).
 */

import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { config } from './config.js';

export interface CallerIdentity {
  /** Okta user id (the `sub` claim) — the ONLY trusted principal. */
  subject: string;
  /** Convenience claims for logging / FGA user keys. */
  email?: string;
  login?: string;
}

// Lazily-built remote JWKS for the org authorization server.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const jwksUri = `${config.okta.issuer.replace(/\/$/, '')}/oauth2/v1/keys`;
    jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  return jwks;
}

function claimsToIdentity(claims: Record<string, unknown>): CallerIdentity | null {
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subject || subject.trim() === '') return null; // fail-closed
  return {
    subject,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    login:
      typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : undefined,
  };
}

/**
 * Resolve the verified caller identity from a raw bearer token.
 * Returns `null` on ANY failure (missing token, bad signature, no `sub`).
 */
export async function resolveCallerIdentity(
  bearerToken: string | undefined
): Promise<CallerIdentity | null> {
  if (!bearerToken || bearerToken.trim() === '') return null;

  if (!config.identity.verifyTokens) {
    // Verification explicitly disabled (e.g. behind a trusted, validating
    // adapter in a closed test). Decode only — never do this on an exposed edge.
    try {
      return claimsToIdentity(decodeJwt(bearerToken) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  try {
    const { payload } = await jwtVerify(bearerToken, getJwks(), {
      issuer: config.okta.issuer.replace(/\/$/, ''),
    });
    return claimsToIdentity(payload as Record<string, unknown>);
  } catch (err) {
    console.error(
      '[identity] Token verification failed (denying):',
      err instanceof Error ? err.message : String(err)
    );
    return null; // fail-closed
  }
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function bearerFromHeader(authHeader: string | undefined): string | undefined {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.substring(7).trim() || undefined;
}
