/**
 * Tool: list_my_owned_groups
 *
 * Returns the groups the caller owns. Inherently scoped to the verified
 * identity: there is NO group argument, so there is no foreign group to leak.
 * With FGA on this is a single ListObjects; with FGA off it uses the Okta
 * owner index — same result, proving the baseline needs no FGA.
 */

import { listOwnedGroupIds } from '../policy/ownership.js';
import { groupsClient } from '../okta/groups-client.js';
import { jsonResult, errorResult, type Tool, type ToolContext } from './types.js';

async function handler(_args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const ids = await listOwnedGroupIds(ctx.subject);
    // Resolve names for display; skip any that fail (fail-closed = omit).
    const groups = [];
    for (const id of ids) {
      try {
        const g = await groupsClient.getById(id);
        groups.push({ id: g.id, name: g.profile.name, description: g.profile.description });
      } catch {
        groups.push({ id, name: '(unavailable)' });
      }
    }
    return jsonResult({ total: groups.length, groups });
  } catch (err) {
    return errorResult(
      `Failed to list owned groups: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}

export const listMyOwnedGroupsTool: Tool = {
  name: 'list_my_owned_groups',
  description:
    'List the Okta groups you own. Takes no arguments — results are always scoped ' +
    'to you, the authenticated caller. Use this first to discover which groups you can manage.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler,
};
