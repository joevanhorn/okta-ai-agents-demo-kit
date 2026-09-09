/**
 * Tool registry — the complete surface of this server. Deliberately tiny:
 * three group-owner tools, nothing else. No admin tools exist to be tricked into.
 */

import { listMyOwnedGroupsTool } from './list-my-owned-groups.js';
import { listOwnedGroupMembersTool } from './list-owned-group-members.js';
import { manageOwnedGroupMembershipTool } from './manage-owned-group-membership.js';
import type { Tool } from './types.js';

export const tools: Tool[] = [
  listMyOwnedGroupsTool,
  listOwnedGroupMembersTool,
  manageOwnedGroupMembershipTool,
];

export const toolsByName: Map<string, Tool> = new Map(tools.map((t) => [t.name, t]));
