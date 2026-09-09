/**
 * THE SECURITY CHOKE POINT.
 *
 * Every tool that reads members of, or mutates membership on, a group MUST call
 * assertCallerOwnsGroup() BEFORE touching any Okta member/user API. This is the
 * only place "does the caller own this group?" is decided. It is fail-closed and
 * source-agnostic (Okta at Layer 2, FGA at Layer 3 — see owner-source.ts).
 *
 * `subject` MUST come from the verified bearer token (identity.ts / context),
 * NEVER from a tool argument. That is what makes the gate immune to prompt
 * engineering: the LLM cannot choose whose ownership is checked.
 */

import { getOwnershipSource } from './owner-source.js';

export class NotGroupOwnerError extends Error {
  readonly subject: string;
  readonly groupId: string;
  constructor(subject: string, groupId: string) {
    super(`Access denied: subject '${subject}' is not an owner of group '${groupId}'`);
    this.name = 'NotGroupOwnerError';
    this.subject = subject;
    this.groupId = groupId;
    Object.setPrototypeOf(this, NotGroupOwnerError.prototype);
  }
}

/**
 * Assert `subject` owns `groupId`. Resolves on success; throws
 * NotGroupOwnerError on any denial or error (fail-closed).
 */
export async function assertCallerOwnsGroup(subject: string, groupId: string): Promise<void> {
  if (!subject || subject.trim() === '') throw new NotGroupOwnerError('(empty)', groupId);
  if (!groupId || groupId.trim() === '') throw new NotGroupOwnerError(subject, '(empty)');

  const source = getOwnershipSource();
  let owned: boolean;
  try {
    owned = await source.isOwner(subject, groupId);
  } catch (err) {
    console.error(
      `[ownership] source '${source.label}' threw (deny) subject=${subject} group=${groupId}:`,
      err instanceof Error ? err.message : String(err)
    );
    throw new NotGroupOwnerError(subject, groupId);
  }
  if (!owned) throw new NotGroupOwnerError(subject, groupId);
}

/** List the group ids the caller owns (via the active source). Fail-closed. */
export async function listOwnedGroupIds(subject: string): Promise<string[]> {
  if (!subject || subject.trim() === '') return [];
  return getOwnershipSource().listOwnedGroupIds(subject);
}
