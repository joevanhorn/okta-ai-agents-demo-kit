/**
 * Ownership source — the pluggable "authority" behind the gate.
 *
 * The gate (ownership.ts) never cares WHERE the ownership fact comes from. That
 * is the whole point of the layered story:
 *   - OktaOwnershipSource  (Layer 2) — Okta group-owner data is the authority.
 *   - FgaOwnershipSource   (Layer 3) — Okta FGA relationship tuples are the
 *                                       authority (externalized decision).
 * Swapping the source changes NOTHING about how tools call the gate, and the
 * baseline (Layer 2) works with FGA entirely absent.
 *
 * BOTH sources are fail-closed: any error resolves to "not owned" / empty.
 */

import { config } from '../config.js';
import { groupsClient } from '../okta/groups-client.js';
import { check as fgaCheck, listObjects as fgaListObjects } from '../fga/fga-client.js';

export interface OwnershipSource {
  /** Layer name, for logging / demo narration. */
  readonly label: string;
  /** Is `subject` an owner of `groupId`? Fail-closed. */
  isOwner(subject: string, groupId: string): Promise<boolean>;
  /** Group ids `subject` owns. Fail-closed (returns [] on error). */
  listOwnedGroupIds(subject: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Layer 2 — Okta ownership (with a small in-memory index for the list op)
// ---------------------------------------------------------------------------

class OktaOwnershipSource implements OwnershipSource {
  readonly label = 'okta';

  private byOwner: Map<string, Set<string>> = new Map();
  private builtAt = 0;
  private building: Promise<void> | null = null;
  private readonly ttlMs = 5 * 60 * 1000;

  private async ensureIndex(): Promise<void> {
    if (Date.now() - this.builtAt < this.ttlMs && this.builtAt > 0) return;
    if (this.building) return this.building;
    this.building = this.build().finally(() => (this.building = null));
    return this.building;
  }

  private async build(): Promise<void> {
    const groups = await groupsClient.listAllGroups();
    const next = new Map<string, Set<string>>();
    for (const g of groups) {
      let owners;
      try {
        owners = await groupsClient.listOwners(g.id);
      } catch {
        continue; // skip a group we can't read; index stays otherwise valid
      }
      for (const o of owners) {
        if (!next.has(o.id)) next.set(o.id, new Set());
        next.get(o.id)!.add(g.id);
      }
    }
    this.byOwner = next;
    this.builtAt = Date.now();
  }

  /**
   * Authoritative live check — one Okta call, no index staleness. Fail-closed.
   * This is what actually gates a specific group access; the index is only an
   * optimization for the list operation.
   */
  async isOwner(subject: string, groupId: string): Promise<boolean> {
    try {
      const owners = await groupsClient.listOwners(groupId);
      return owners.some((o) => o.id === subject);
    } catch (err) {
      console.error('[owner-source:okta] isOwner error (deny):', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async listOwnedGroupIds(subject: string): Promise<string[]> {
    try {
      await this.ensureIndex();
      return Array.from(this.byOwner.get(subject) ?? []);
    } catch (err) {
      console.error('[owner-source:okta] list error (deny):', err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — Okta FGA ownership (relationship tuples are the authority)
// ---------------------------------------------------------------------------

class FgaOwnershipSource implements OwnershipSource {
  readonly label = 'fga';

  async isOwner(subject: string, groupId: string): Promise<boolean> {
    return fgaCheck(`user:${subject}`, 'owner', `group:${groupId}`);
  }

  async listOwnedGroupIds(subject: string): Promise<string[]> {
    return fgaListObjects(`user:${subject}`, 'owner', 'group');
  }
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

const oktaSource = new OktaOwnershipSource();
const fgaSource = new FgaOwnershipSource();

/**
 * Which source is authoritative right now. FGA only when explicitly enabled;
 * otherwise the Okta source — proving the baseline needs no FGA.
 */
export function getOwnershipSource(): OwnershipSource {
  return config.fga.enabled ? fgaSource : oktaSource;
}
