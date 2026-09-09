/**
 * Thin Okta Groups API client — only the operations the demo needs.
 * All calls use the service token; the ownership gate governs WHO may reach them.
 */

import { getServiceAccessToken } from './service-client.js';
import { config } from '../config.js';

const READ = 'okta.groups.read';
const READ_USERS = 'okta.groups.read okta.users.read';
const MANAGE = 'okta.groups.manage';

export interface OktaGroup {
  id: string;
  profile: { name: string; description?: string };
  type?: string;
}

export interface OktaOwner {
  id: string;
  type: string; // "USER" | "GROUP"
}

export interface OktaUser {
  id: string;
  profile: { login: string; email?: string };
}

async function oktaFetch(
  path: string,
  scopes: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getServiceAccessToken(scopes);
  return fetch(`${config.okta.apiV1}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export const groupsClient = {
  /** List USER owners of a group (the authority for Layer 2 ownership). */
  async listOwners(groupId: string): Promise<OktaOwner[]> {
    const resp = await oktaFetch(
      `/groups/${encodeURIComponent(groupId)}/owners?filter=${encodeURIComponent('type eq "USER"')}`,
      READ
    );
    if (!resp.ok) {
      throw new Error(`[groups] listOwners ${groupId}: ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as OktaOwner[];
  },

  async getById(groupId: string): Promise<OktaGroup> {
    const resp = await oktaFetch(`/groups/${encodeURIComponent(groupId)}`, READ);
    if (!resp.ok) {
      throw new Error(`[groups] getById ${groupId}: ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as OktaGroup;
  },

  async listMembers(groupId: string, limit = 200): Promise<OktaUser[]> {
    const resp = await oktaFetch(
      `/groups/${encodeURIComponent(groupId)}/users?limit=${limit}`,
      READ_USERS
    );
    if (!resp.ok) {
      throw new Error(`[groups] listMembers ${groupId}: ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as OktaUser[];
  },

  async isMember(groupId: string, userId: string): Promise<boolean> {
    const resp = await oktaFetch(
      `/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
      READ,
      { method: 'GET' }
    );
    if (resp.status === 404) return false;
    if (!resp.ok) {
      throw new Error(`[groups] isMember ${groupId}/${userId}: ${resp.status} ${await resp.text()}`);
    }
    return true;
  },

  async addMember(groupId: string, userId: string): Promise<void> {
    const resp = await oktaFetch(
      `/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
      MANAGE,
      { method: 'PUT' }
    );
    if (!resp.ok) {
      throw new Error(`[groups] addMember ${groupId}/${userId}: ${resp.status} ${await resp.text()}`);
    }
  },

  async removeMember(groupId: string, userId: string): Promise<void> {
    const resp = await oktaFetch(
      `/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
      MANAGE,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      throw new Error(`[groups] removeMember ${groupId}/${userId}: ${resp.status} ${await resp.text()}`);
    }
  },

  /** Enumerate ALL groups (Link-header pagination). Used to build the owner index. */
  async listAllGroups(): Promise<OktaGroup[]> {
    const token = await getServiceAccessToken(READ);
    let url: string | null = `${config.okta.apiV1}/groups?limit=200`;
    const out: OktaGroup[] = [];
    while (url) {
      const resp: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!resp.ok) {
        throw new Error(`[groups] listAllGroups: ${resp.status} ${await resp.text()}`);
      }
      out.push(...((await resp.json()) as OktaGroup[]));
      url = parseNextLink(resp.headers.get('link'));
    }
    return out;
  },

  /** Resolve an Okta user by id OR login/email. */
  async getUserByIdOrLogin(idOrLogin: string): Promise<OktaUser> {
    const resp = await oktaFetch(`/users/${encodeURIComponent(idOrLogin)}`, READ_USERS);
    if (!resp.ok) {
      throw new Error(`[groups] getUser ${idOrLogin}: ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as OktaUser;
  },
};
