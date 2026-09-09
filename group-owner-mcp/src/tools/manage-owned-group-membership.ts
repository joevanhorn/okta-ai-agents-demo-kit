/**
 * Tool: manage_owned_group_membership
 *
 * check / add / remove a MEMBER of a group the caller owns. The ownership gate
 * runs BEFORE any user resolution or mutation. This tool has ZERO code paths to
 * any /owners endpoint — it manages members only, never ownership.
 */

import { assertCallerOwnsGroup, NotGroupOwnerError } from '../policy/ownership.js';
import { groupsClient } from '../okta/groups-client.js';
import { jsonResult, errorResult, type Tool, type ToolContext } from './types.js';

type Action = 'check' | 'add' | 'remove';

async function handler(args: Record<string, unknown>, ctx: ToolContext) {
  const groupId = typeof args.groupId === 'string' ? args.groupId : '';
  const userId = typeof args.userId === 'string' ? args.userId : '';
  const action = args.action as Action;

  if (!groupId || !userId || !action) {
    return errorResult('Missing required arguments: groupId, userId, action');
  }
  if (!['check', 'add', 'remove'].includes(action)) {
    return errorResult('Invalid action. Must be one of: check, add, remove');
  }

  try {
    // SECURITY GATE — before resolving the target user or touching membership.
    await assertCallerOwnsGroup(ctx.subject, groupId);

    const user = await groupsClient.getUserByIdOrLogin(userId);
    const group = await groupsClient.getById(groupId);
    const base = {
      group: { id: group.id, name: group.profile.name },
      user: { id: user.id, login: user.profile.login },
    };

    if (action === 'check') {
      const isMember = await groupsClient.isMember(groupId, user.id);
      return jsonResult({
        action,
        ...base,
        result: isMember ? 'is_member' : 'not_member',
        message: `${user.profile.login} ${isMember ? 'IS' : 'is NOT'} a member of "${group.profile.name}".`,
      });
    }

    if (action === 'add') {
      if (await groupsClient.isMember(groupId, user.id)) {
        return jsonResult({ action, ...base, result: 'is_member', message: `${user.profile.login} is already a member of "${group.profile.name}" — no change.` });
      }
      await groupsClient.addMember(groupId, user.id);
      return jsonResult({ action, ...base, result: 'added', message: `Added ${user.profile.login} to "${group.profile.name}".` });
    }

    // remove
    if (!(await groupsClient.isMember(groupId, user.id))) {
      return jsonResult({ action, ...base, result: 'not_member', message: `${user.profile.login} is not a member of "${group.profile.name}" — no change.` });
    }
    await groupsClient.removeMember(groupId, user.id);
    return jsonResult({ action, ...base, result: 'removed', message: `Removed ${user.profile.login} from "${group.profile.name}".` });
  } catch (err) {
    if (err instanceof NotGroupOwnerError) {
      return errorResult('You do not own this group, or it does not exist.');
    }
    return errorResult(
      `Failed to manage group membership: ${err instanceof Error ? err.message : 'Unknown error'}`
    );
  }
}

export const manageOwnedGroupMembershipTool: Tool = {
  name: 'manage_owned_group_membership',
  description:
    "Add, remove, or check a user's membership in a group you own. Only works for " +
    'groups where you are a direct owner. This tool NEVER modifies group ownership — members only.',
  inputSchema: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: 'Group ID. Must be a group you own.' },
      userId: { type: 'string', description: 'Okta user ID, login, or email of the target user.' },
      action: { type: 'string', enum: ['check', 'add', 'remove'], description: 'What to do.' },
    },
    required: ['groupId', 'userId', 'action'],
    additionalProperties: false,
  },
  handler,
};
