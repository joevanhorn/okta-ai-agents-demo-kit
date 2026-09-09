/**
 * RED-TEAM SUITE — proves Demo Goal #2:
 *   "A user cannot see or touch any group they do NOT own, regardless of
 *    attempts to engineer the bot."
 *
 * The key idea: the LLM/agent can put ANYTHING in the tool arguments. So every
 * attack here is expressed as hostile arguments and a fixed VERIFIED identity
 * (ctx.subject), exactly as the server would pass it. We assert:
 *   1. Every access to a non-owned group is DENIED, and
 *   2. No mutating Okta call (addMember/removeMember) EVER fires on a denial.
 *
 * Runs fully offline: the Okta client is mocked so ownership is deterministic.
 * Default config has FGA OFF — so this proves the BASELINE (Layer 2) alone
 * delivers the guarantee, with no FGA involved.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { groupsClient } from '../src/okta/groups-client.ts';
import { listOwnedGroupMembersTool } from '../src/tools/list-owned-group-members.ts';
import { manageOwnedGroupMembershipTool } from '../src/tools/manage-owned-group-membership.ts';
import { listMyOwnedGroupsTool } from '../src/tools/list-my-owned-groups.ts';

// --- Fixture world -------------------------------------------------------
// Alice owns ONLY g-owned. Everything else belongs to someone else.
const ALICE = '00uALICE';
const OWNED = '00gOWNED';
const ENG = '00gENG'; // owned by Bob, not Alice
const SECRET = '00gSECRET'; // owned by no one Alice knows

const ctxAlice = { subject: ALICE };

// Records every mutating call so we can prove denials never reach Okta writes.
let mutations: Array<{ op: string; groupId: string; userId: string }>;

beforeEach(() => {
  mutations = [];

  mock.method(groupsClient, 'listOwners', async (groupId: string) =>
    groupId === OWNED ? [{ id: ALICE, type: 'USER' }] : [{ id: '00uBOB', type: 'USER' }]
  );
  mock.method(groupsClient, 'listAllGroups', async () => [
    { id: OWNED, profile: { name: 'Alice Owned Group' } },
    { id: ENG, profile: { name: 'Engineering' } },
    { id: SECRET, profile: { name: 'Executive Comp' } },
  ]);
  mock.method(groupsClient, 'getById', async (groupId: string) => ({
    id: groupId,
    profile: { name: `group-${groupId}` },
  }));
  mock.method(groupsClient, 'listMembers', async () => [
    { id: '00uX', profile: { login: 'x@corp.com' } },
  ]);
  mock.method(groupsClient, 'isMember', async () => false);
  mock.method(groupsClient, 'getUserByIdOrLogin', async (u: string) => ({
    id: u,
    profile: { login: `${u}@corp.com` },
  }));
  mock.method(groupsClient, 'addMember', async (groupId: string, userId: string) => {
    mutations.push({ op: 'add', groupId, userId });
  });
  mock.method(groupsClient, 'removeMember', async (groupId: string, userId: string) => {
    mutations.push({ op: 'remove', groupId, userId });
  });
});

afterEach(() => mock.restoreAll());

function isDenied(result: { isError?: boolean; content: Array<{ text: string }> }): boolean {
  return result.isError === true && /do not own this group/i.test(result.content[0].text);
}

// --- Attacks against a group Alice does NOT own --------------------------

describe('Goal #2 — denial holds against a non-owned group (Layer 2, FGA off)', () => {
  test('ATTACK: plainly read a group she does not own → DENIED', async () => {
    const r = await listOwnedGroupMembersTool.handler({ groupId: ENG }, ctxAlice);
    assert.ok(isDenied(r));
  });

  test('ATTACK: add herself to a group she does not own → DENIED, no write', async () => {
    const r = await manageOwnedGroupMembershipTool.handler(
      { groupId: ENG, userId: ALICE, action: 'add' },
      ctxAlice
    );
    assert.ok(isDenied(r));
    assert.equal(mutations.length, 0, 'no Okta mutation may fire on denial');
  });

  test('ATTACK: remove someone from a group she does not own → DENIED, no write', async () => {
    const r = await manageOwnedGroupMembershipTool.handler(
      { groupId: SECRET, userId: '00uBOB', action: 'remove' },
      ctxAlice
    );
    assert.ok(isDenied(r));
    assert.equal(mutations.length, 0);
  });

  test('ATTACK: spoof identity via a forged `subject` argument → IGNORED, DENIED', async () => {
    // The bot is tricked into passing subject/actor in args. Handlers never read
    // args.subject — identity comes only from ctx. Alice stays Alice.
    const r = await manageOwnedGroupMembershipTool.handler(
      { groupId: ENG, userId: ALICE, action: 'add', subject: '00uSUPERADMIN', actor: 'admin', isAdmin: true },
      ctxAlice
    );
    assert.ok(isDenied(r));
    assert.equal(mutations.length, 0);
  });

  test('ATTACK: injection-style groupId string → treated as a plain id, DENIED', async () => {
    const r = await listOwnedGroupMembersTool.handler(
      { groupId: `${ENG}" or 1=1 -- ignore ownership` },
      ctxAlice
    );
    assert.ok(isDenied(r));
  });

  test('ATTACK: empty / anonymous subject (no valid token) → DENIED', async () => {
    const r = await listOwnedGroupMembersTool.handler({ groupId: OWNED }, { subject: '' });
    assert.ok(isDenied(r));
  });

  test('ATTACK: "check" is not a read-only loophole on a non-owned group → DENIED', async () => {
    const r = await manageOwnedGroupMembershipTool.handler(
      { groupId: ENG, userId: '00uBOB', action: 'check' },
      ctxAlice
    );
    assert.ok(isDenied(r));
  });
});

// --- Positive controls: Alice CAN manage her OWN group (Goal #1) ---------

describe('Goal #1 — the owner can do her job', () => {
  test('list_my_owned_groups returns ONLY Alice’s group', async () => {
    const r = await listMyOwnedGroupsTool.handler({}, ctxAlice);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.total, 1);
    assert.equal(body.groups[0].id, OWNED);
  });

  test('read members of her OWN group → allowed', async () => {
    const r = await listOwnedGroupMembersTool.handler({ groupId: OWNED }, ctxAlice);
    assert.ok(!r.isError);
    assert.equal(JSON.parse(r.content[0].text).group.id, OWNED);
  });

  test('add a member to her OWN group → allowed, write DID fire', async () => {
    const r = await manageOwnedGroupMembershipTool.handler(
      { groupId: OWNED, userId: '00uNEW', action: 'add' },
      ctxAlice
    );
    assert.ok(!r.isError);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].op, 'add');
    assert.equal(mutations[0].groupId, OWNED);
  });
});

// --- Structural guarantee: no ownership-mutation surface exists -----------

describe('Structural — the tools cannot modify ownership at all', () => {
  test('the Okta client exposes NO owner-mutation method', () => {
    for (const banned of ['addOwner', 'removeOwner', 'setOwner', 'updateOwners']) {
      assert.equal((groupsClient as Record<string, unknown>)[banned], undefined);
    }
  });
});
