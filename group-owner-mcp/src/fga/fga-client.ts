/**
 * LAYER 3 (optional) — Okta FGA client.
 *
 * IMPORTANT contrast with the sibling Bedrock demo's fga.ts, which fails OPEN
 * ("return true" on error) because it is an availability-oriented gate. Here the
 * guarantee is DENIAL, so every path fails CLOSED: any error → not allowed.
 *
 * FGA models group ownership as a relationship:
 *     user:<oktaUserId>  owner  group:<groupId>
 * so "does the caller own this group?" becomes a single check(), and
 * "which groups does the caller own?" becomes listObjects().
 */

import { config } from '../config.js';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getFgaToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  const resp = await fetch(config.fga.tokenIssuer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.fga.clientId,
      client_secret: config.fga.clientSecret,
      audience: config.fga.audience,
    }),
  });
  if (!resp.ok) {
    throw new Error(`[fga] auth failed: ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function fgaFetch(path: string, body: unknown): Promise<Response> {
  const token = await getFgaToken();
  return fetch(`${config.fga.apiUrl}/stores/${config.fga.storeId}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Relationship check. Fail-CLOSED: returns false on any error.
 */
export async function check(user: string, relation: string, object: string): Promise<boolean> {
  try {
    const resp = await fgaFetch('/check', {
      authorization_model_id: config.fga.modelId,
      tuple_key: { user, relation, object },
    });
    if (!resp.ok) {
      console.error(`[fga] check failed (deny): ${resp.status} ${await resp.text()}`);
      return false; // fail-closed
    }
    const data = (await resp.json()) as { allowed?: boolean };
    return data.allowed === true;
  } catch (err) {
    console.error('[fga] check error (deny):', err instanceof Error ? err.message : String(err));
    return false; // fail-closed
  }
}

/**
 * Reverse query: all object ids of `type` where `user` has `relation`.
 * Fail-CLOSED: returns [] on any error (never invents access).
 */
export async function listObjects(
  user: string,
  relation: string,
  type: string
): Promise<string[]> {
  try {
    const resp = await fgaFetch('/list-objects', {
      authorization_model_id: config.fga.modelId,
      user,
      relation,
      type,
    });
    if (!resp.ok) {
      console.error(`[fga] list-objects failed (deny): ${resp.status} ${await resp.text()}`);
      return [];
    }
    const data = (await resp.json()) as { objects?: string[] };
    // FGA returns fully-qualified objects e.g. "group:00g123" — strip the type.
    return (data.objects ?? []).map((o) => (o.startsWith(`${type}:`) ? o.slice(type.length + 1) : o));
  } catch (err) {
    console.error('[fga] list-objects error (deny):', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Write an ownership tuple (used by the sync job). */
export async function writeOwnerTuple(userId: string, groupId: string): Promise<void> {
  const resp = await fgaFetch('/write', {
    authorization_model_id: config.fga.modelId,
    writes: { tuple_keys: [{ user: `user:${userId}`, relation: 'owner', object: `group:${groupId}` }] },
  });
  // Ignore "already exists" (400) so the sync is idempotent.
  if (!resp.ok && resp.status !== 400) {
    throw new Error(`[fga] writeOwnerTuple ${userId}->${groupId}: ${resp.status} ${await resp.text()}`);
  }
}
