/**
 * Okta service token (private-key-JWT client credentials).
 *
 * This is the powerful, org-wide token that CAN read every group. That is
 * precisely why enforcement matters: the ownership gate decides whether a given
 * caller may use it for a given group. The token itself is never handed to the
 * LLM and never scoped per-user at Layer 2 — the gate is the control.
 *
 * (Layer 4 in the docs replaces this broad token with an ID-JAG / on-behalf-of
 * token whose Okta custom-admin-role resource set scopes it to the owned groups,
 * pushing enforcement into the platform. Not used at this layer.)
 */

import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';
import { config } from '../config.js';

interface CacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

const cache = new Map<string, CacheEntry>();

async function buildClientAssertion(): Promise<string> {
  const pem = readFileSync(config.okta.privateKeyPath, 'utf8');
  const key = await importPKCS8(pem, 'RS256');
  const tokenEndpoint = `${config.okta.issuer.replace(/\/$/, '')}/oauth2/v1/token`;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(config.okta.clientId)
    .setSubject(config.okta.clientId)
    .setAudience(tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(`${now}-${Math.floor(now / 7)}`)
    .sign(key);
}

/**
 * Return a cached-or-fresh service access token for the requested scopes.
 */
export async function getServiceAccessToken(scopes: string): Promise<string> {
  const cached = cache.get(scopes);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const assertion = await buildClientAssertion();
  const tokenEndpoint = `${config.okta.issuer.replace(/\/$/, '')}/oauth2/v1/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: scopes,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(
      `[service-client] Token request failed: ${resp.status} ${resp.statusText}: ${await resp.text()}`
    );
  }

  const json = (await resp.json()) as { access_token: string; expires_in: number };
  cache.set(scopes, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}
