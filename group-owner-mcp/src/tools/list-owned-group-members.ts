/**
 * Tool: list_owned_group_members
 *
 * Lists members of a group the caller owns. The ownership gate runs BEFORE any
 * Okta member/group call; on denial it returns a message that does NOT reveal
 * whether the group exists.
 */

import { assertCallerOwnsGroup, NotGroupOwnerError } from '../policy/ownership.js';
import { groupsClient } from '../okta/groups-client.js';
import { jsonResult, errorResult, type Tool, type ToolContext } from './types.js';

async function handler(args: Record<string, unknown>, ctx: ToolContext) {
  const groupId = typeof args.groupId === 'string' ? args.groupId : '';
  const limit = typeof args.limit === 'number' ? args.limit : 200;

  if (!groupId) return errorResult('Missing required argument: groupId');

  try {
    // SECURITY GATE — before any Okta call. subject is from the token, not args.
    await assertCallerOwnsGroup(ctx.subject, groupId);

    const group = await groupsClient.getById(groupId);
    const members = await groupsClient.listMembers(groupId, limit);
    return jsonResult({
      group: { id: group.id, name: group.profile.name, description: group.profile.description },
      memberCount: members.length,
      members: members.map((u) => ({ id: u.id, login: u.profile.login, email: u.profile.email })),
    });
  } catch (err) {
    if (err instanceof NotGroupOwnerError) {
      return errorResult('You do not own this group, or it does not exist.');
    }
    return errorResult(
      `Failed to list group members: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}

export const listOwnedGroupMembersTool: Tool = {
  name: 'list_owned_group_members',
  description:
    'List the members of a group you own. Only works for groups where you are a ' +
    'direct owner. Use list_my_owned_groups first to find your group IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: 'Group ID (e.g. 00g123). Must be a group you own.' },
      limit: { type: 'number', description: 'Max members to return (default 200).' },
    },
    required: ['groupId'],
    additionalProperties: false,
  },
  handler,
};
