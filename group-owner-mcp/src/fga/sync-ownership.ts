/**
 * FGA ownership sync (Layer 3 provisioning).
 *
 * Mirrors Okta group-owner facts into FGA `owner` tuples:
 *     user:<oktaUserId>  owner  group:<groupId>
 * so FGA becomes the authoritative source for the ownership decision. Run on
 * demand (`npm run sync-fga`) for the demo; in production an Okta event hook
 * writing a tuple on owner-add is the real-time equivalent.
 *
 * This is deliberately the SAME data the Layer 2 gate reads live — Layer 3 just
 * relocates the decision, it does not change the answer.
 */

import { config } from '../config.js';
import { groupsClient } from '../okta/groups-client.js';
import { writeOwnerTuple } from './fga-client.js';

async function main(): Promise<void> {
  if (!config.fga.enabled) {
    console.error('[sync-fga] FGA_ENABLED is not "true" — nothing to sync. Set it to run.');
    process.exit(1);
  }
  console.log('[sync-fga] enumerating groups + owners…');
  const groups = await groupsClient.listAllGroups();
  let tuples = 0;
  for (const g of groups) {
    let owners;
    try {
      owners = await groupsClient.listOwners(g.id);
    } catch (err) {
      console.warn(`[sync-fga] skip group ${g.id}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const o of owners) {
      await writeOwnerTuple(o.id, g.id);
      tuples++;
    }
  }
  console.log(`[sync-fga] wrote ${tuples} owner tuple(s) across ${groups.length} group(s).`);
}

main().catch((err) => {
  console.error('[sync-fga] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
