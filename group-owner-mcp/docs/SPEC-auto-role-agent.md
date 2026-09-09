# SPEC: Automatic Custom Role & Resource Management Agent

**Status:** PROPOSAL — not built. Depends on prerequisites listed in §11.
**Author:** joevanhorn (taskvantage.okta.com)
**Date:** 2026-07-01
**Target runtime:** CrewAI (matching `../../../crewai-demo/` pattern)
**Related architecture:** `./ARCHITECTURE.md` (Layer 4 — Platform-Layer Scoping)

---

## Table of Contents

1. [Purpose & Problem](#1-purpose--problem)
2. [Where It Runs & Why](#2-where-it-runs--why)
3. [Trigger Model](#3-trigger-model)
4. [What It Manages in Okta](#4-what-it-manages-in-okta)
5. [A2A Architecture](#5-a2a-architecture)
6. [Runtime Payoff](#6-runtime-payoff)
7. [Least-Privilege & Separation of Duties](#7-least-privilege--separation-of-duties)
8. [Reconciliation & Drift Handling](#8-reconciliation--drift-handling)
9. [Security Considerations & Failure Modes](#9-security-considerations--failure-modes)
10. [Build Phases & Milestones](#10-build-phases--milestones)
11. [Open Questions & Prerequisites](#11-open-questions--prerequisites)

---

## 1. Purpose & Problem

### What this agent does

The **Auto-Role Agent** automatically provisions and maintains the Okta platform-layer identity scoping that makes delegated group-owner self-service *enforceable by the Okta platform itself*, not just by application code. Concretely, it:

1. Detects that a user should become the delegated manager of one or more Okta groups.
2. Ensures a **custom admin role** exists with the minimum permissions needed to manage group membership (view members, add members, remove members) — and explicitly excludes owner-mutation and org-wide group admin.
3. Ensures a **resource set** is scoped to exactly the groups that user owns — no more, no less.
4. **Binds** the custom role to the resource set and **assigns** that binding to the user, so the user's Okta admin token is constrained at the platform layer.
5. Keeps everything in sync as ownership changes: adds groups to a resource set when a user gains ownership, removes groups when ownership is revoked, and revokes the role assignment entirely when the user's last owned group is removed.

### The problem it solves (Layer 4)

The existing group-owner-mcp implementation enforces ownership at **Layer 2** (Okta `GET /groups/{id}/owners` — app-layer check) and optionally **Layer 3** (Okta FGA relationship tuples — externalized decision). Both layers work, but enforcement lives inside the MCP server's application code.

Layer 4, described in `./ARCHITECTURE.md`, pushes enforcement down to the **Okta platform itself**:

- When a user acts through an AI agent (after ID-JAG / XAA token exchange), the access token the agent holds **inherits the user's custom-admin-role and resource-set constraints**. The Okta API literally only returns the groups that user is authorized to manage — no additional app-layer gate is needed.
- This makes the permission boundary **auditable, revocable, and portable**. Any agent or tool that consults the Okta Groups API with a properly scoped token respects the boundary automatically — including the official Okta MCP server.
- It also eliminates the "service token does all the privileged work; app enforces the gate" coupling. At Layer 4, the *token itself* is the gate.

### Why this matters for the demo

The payoff story for SE demos: "We don't trust application code to enforce the boundary. We provision the right Okta admin role so the *identity layer* enforces it, and any agent carrying the user's token can safely be pointed at the Okta Groups API without the developer having to re-implement the ownership check."

---

## 2. Where It Runs & Why

### Runtime: CrewAI

This agent runs as a **headless CrewAI crew** using the same pattern as `../crewai-demo/`:

- **Authentication**: Okta `client_credentials` + `private_key_jwt`. The agent mints its own scoped access token from a **custom authorization server** on every run. There is no human in the loop, no browser-based OAuth, and no session persistence.
- **Token lifetime**: Access tokens are re-minted on each crew run (same pattern as the crewai-demo's watch loop). The token is short-lived; the RSA private key is the long-lived credential.
- **Scheduling**: Run via cron, a systemd timer, or an ECS scheduled task — same choices as the crewai-demo.
- **LLM usage**: The agent uses an LLM for reasoning and tool orchestration. It does **not** use the LLM for policy decisions — those are hard-coded into the crew's task definitions and validated against Okta API responses.

### The agent's Okta identity

The auto-role agent has its own dedicated **Okta application** (API Services app, `client_credentials` only):

- **Client credentials**: RSA private key stored in AWS SSM Parameter Store under the `taskvantage` account (`959737396568`), following the crewai-demo pattern (`/taskvantage-prod/auto-role-agent/client-id`, `/auto-role-agent/key-id`, `/auto-role-agent/private-key`).
- **Scopes granted**: Only the scopes needed for role and resource-set management (`okta.roles.manage`, `okta.groups.read`, `okta.users.read`). Provisioned via Terraform.
- **Custom auth server**: The same custom authorization server used by the rest of the AI-agent-demo environment (or a dedicated one if the token policy needs isolation).

The agent's identity is **separate from and more privileged than** the user-facing group-owner agent. This separation is deliberate and is the crux of the security model described in §7.

### Why CrewAI and not a Lambda / simple script

- Mirrors the existing crewai-demo investment: same credential pattern, same token-minting library, same deployment model.
- A crew can express multi-step reasoning (detect signal → check current state → compute diff → apply changes → verify) cleanly as sequential tasks with tool calls.
- The LLM reasoning step is valuable: "does a compatible resource set already exist for this user? Should I extend it or create a new one?" is not a trivial branching decision at scale.
- An event-driven Lambda is a reasonable alternative for the trigger path (see §3), but the reconciliation and drift-handling work (§8) benefits from the crew model.

---

## 3. Trigger Model

The agent is designed to respond to three signal types. All three can coexist.

### Signal A — Okta Event Hook (group-owner-added)

Okta fires a `group.user_membership.add_initiator` event or, more precisely, a `group.assign_owner` event when a user is made a group owner. A lightweight webhook receiver (a small HTTP endpoint, e.g., an AWS Lambda or a FastAPI route on the demo host) accepts the event hook payload, validates the shared secret, and enqueues a run of the auto-role crew for the affected user.

**Characteristics:**
- Near-real-time (seconds after ownership is granted).
- Payload contains the user ID and group ID.
- Requires Okta Event Hook configuration pointing at a public HTTPS endpoint.

**Limitation:** Not all Okta event types fire a hook — test on the tenant that `group.assign_owner` is available before relying on this path.

### Signal B — Access Request / Workflow Approval

When an Okta Workflow (or an OIG access request) grants group-owner status as the outcome of an approval, it can call a webhook or invoke the auto-role crew directly via an HTTP card. This is the cleanest integration for OIG-driven workflows: the workflow that makes someone an owner also fires the provisioning signal.

**Characteristics:**
- Deterministic — the workflow knows *exactly* what changed.
- No separate event hook infrastructure needed.
- Requires the Okta Workflow to include an HTTP Request card pointing at the agent's trigger endpoint.

### Signal C — Scheduled Reconciliation

A cron-driven full-reconciliation run (default: every 15 minutes, configurable). The crew enumerates all Okta group owners, computes the desired state of all custom role + resource set bindings, diffs against current state, and applies only the deltas.

**Characteristics:**
- Catches any changes that Signals A/B missed (e.g., ownership changes made directly in the Okta Admin UI, API changes, or hook delivery failures).
- Higher Okta API load than the event-driven signals — paginate carefully on large tenants.
- Sufficient alone for a demo; required in production as the safety net for the other two signals.

**Recommendation:** Build Signal C first. Add Signals A and B incrementally.

---

## 4. What It Manages in Okta

This section names the specific Okta constructs and API surfaces the agent touches. It does not specify API call signatures in detail — those belong in implementation tickets.

### 4.1 Custom Admin Role (one role, shared across all delegated group owners)

The agent ensures exactly **one custom admin role** exists in the tenant with the following properties:

**Name (proposed):** `Delegated-Group-Member-Manager`

**Permissions (least-privilege — member management only):**
- `okta.groups.read` — view group details
- `okta.groups.members.manage` — add and remove members
- `okta.users.read` — resolve user profiles for membership display

**Explicitly excluded:**
- `okta.groups.owners.manage` — owner mutation is out of scope (hard requirement from the group-owner-mcp plan)
- `okta.groups.manage` — org-wide group admin (too broad)
- `okta.groups.create` / `okta.groups.delete` — not needed

**Okta API surface:** `Roles API`
- `GET /api/v1/iam/roles` — list roles, find by name
- `POST /api/v1/iam/roles` — create if not present
- `PUT /api/v1/iam/roles/{roleId}` — update permissions if role exists but is stale

**Strategy:** The agent creates the role once and reuses it. It does not create a new role per user. The per-user scoping is done by the resource set (see 4.2), not by a distinct role per user.

### 4.2 Resource Sets (one per user who has at least one owned group)

A resource set limits the targets a custom admin role binding applies to. The agent manages **one resource set per delegated group owner**, named by a stable convention:

**Name pattern:** `group-owner-{userId}` (e.g., `group-owner-00u23s6twjpJR2PXE1d8`)

**Contents:** Exactly the set of groups the user owns. As ownership changes:
- Owner gains group G → G is added to the resource set.
- Owner loses group G → G is removed from the resource set.
- Owner loses all groups → resource set is deleted (or emptied and the role assignment is revoked).

**Okta API surface:** `Resource Sets API`
- `GET /api/v1/iam/resource-sets` — list, find by name
- `POST /api/v1/iam/resource-sets` — create
- `PATCH /api/v1/iam/resource-sets/{resourceSetId}` — add/remove resources (groups) by ORN
- `DELETE /api/v1/iam/resource-sets/{resourceSetId}` — clean up when no groups remain

**Group ORN format:** `orn:okta:{tenant}:groups:{groupId}`

### 4.3 Custom Role Assignments (binding role + resource set to the user)

Once the custom role and resource set exist, the agent creates a **binding** that assigns the role to the user scoped to the resource set.

**Okta API surface:** Custom role assignment endpoints
- `POST /api/v1/users/{userId}/roles` with body `{ "type": "CUSTOM", "role": "{roleId}", "resourceSet": "{resourceSetId}" }` — assign
- `GET /api/v1/users/{userId}/roles` — check if binding exists
- `DELETE /api/v1/users/{userId}/roles/{assignmentId}` — revoke when the user loses all owned groups

**Idempotency requirement:** The agent must check for an existing binding before creating one. Creating duplicate bindings is an Okta API error.

### What the agent explicitly does NOT touch

- Okta group ownership (`/groups/{id}/owners`) — the agent reads ownership to compute desired state but never writes to it.
- Okta FGA tuples — the resource-set mechanism is orthogonal to FGA (Layer 3). Both can coexist.
- The MCP server's owner index — the agent operates at the Okta API layer independently of the MCP server's in-process index.
- Any application outside the group-owner-mcp scope.

---

## 5. A2A Architecture

> This section applies Okta Agent-to-Agent (A2A) to this specific pairing. A2A is a generally available Okta capability (as of 2025) that lets AI agents securely call each other using temporary, resource-scoped tokens issued by a custom authorization server.

### The pairing

| Role | Agent |
|---|---|
| **Caller** | The user-facing group-owner agent (backed by `group-owner-mcp`). This is the agent the end-user talks to. It holds LOW privilege — only the scopes needed to read and manage group membership on the user's owned groups. |
| **Resource** | This auto-role provisioning agent. It holds HIGH privilege — the scopes to create and assign custom admin roles and resource sets. |

The key design decision: **the user-facing agent never itself holds role-assignment power.** When the user-facing agent determines that a provisioning action is needed (e.g., a new group was just added to the user's owned set and the resource set needs updating), it cannot do that work itself. Instead, it delegates to the auto-role agent over an A2A connection.

### How the A2A connection works

1. **Registration:** The auto-role agent is registered as a protected resource in Okta's custom authorization server. Its audience URL (e.g., `api://auto-role-agent`) identifies it as the resource the Caller wants to reach.
2. **Token request:** When the Caller needs to invoke the auto-role agent, it requests a temporary access token from the custom authorization server, specifying the auto-role agent's audience as the resource. The custom auth server checks that a resource connection exists between this Caller and this Resource and that the Caller is authorized.
3. **Token issuance:** The custom auth server issues a short-lived, resource-scoped token. The token is scoped to the auto-role agent's audience only — it cannot be reused to call any other resource.
4. **Invocation:** The Caller presents the token to the auto-role agent's API endpoint. The auto-role agent validates the token (signature, audience, expiry) and processes the request.
5. **Chain of delegation:** Both the Caller's identity and the token exchange are recorded in the Okta System Log. Admins can see: "user-facing agent X obtained a delegation token for provisioning agent Y at time T, acting on behalf of user Z."

### Connection setup: Manual vs. Automatic

| Mode | How it works | Recommended for |
|---|---|---|
| **Manual** | An admin explicitly points a resource connection at the auto-role agent's audience URL in the Okta Admin Console (or via the Connections API). Persistent; survives tenant restarts. | Production. The connection is long-lived and intentional; an admin should review it. |
| **Automatic** | If both agents are registered within the same Okta AI-agent workflow, Okta can establish the connection automatically. | Demo / sandbox where both agents are known to Okta as part of the same workflow. Faster to set up; less explicit auditability of the connection creation event itself. |

**Recommendation for this build:** Start with Manual. It makes the connection explicit and auditable from day one.

### ASCII Sequence Diagram — A2A delegation flow

```
User / Scheduler           User-Facing Agent           Custom Auth Server         Auto-Role Agent
      |                    (group-owner-mcp)            (taskvantage.okta.com)     (this agent)
      |                           |                             |                       |
      |--- chat / cron trigger -->|                             |                       |
      |                           |                             |                       |
      |          [Agent detects ownership change;               |                       |
      |           provisioning work needed]                     |                       |
      |                           |                             |                       |
      |                           |-- request token ----------->|                       |
      |                           |   audience: api://auto-role-agent                   |
      |                           |   (resource connection checked)                     |
      |                           |                             |                       |
      |                           |<-- short-lived A2A token ---|                       |
      |                           |   (scoped to Resource only) |                       |
      |                           |                             |                       |
      |                           |-- POST /provision ----------------------------------------->|
      |                           |   Authorization: Bearer <A2A token>                 |       |
      |                           |                             |                       |       |
      |                           |                             |           [Validates token:    |
      |                           |                             |            audience ✓          |
      |                           |                             |            expiry ✓            |
      |                           |                             |            caller identity ✓]  |
      |                           |                             |                       |       |
      |                           |                             |                [Provisions Okta|
      |                           |                             |                 role/RS/binding]
      |                           |                             |                       |       |
      |                           |<-- 200 OK (provisioning result) ----------------------------+
      |                           |                             |                       |
      |<-- response to user ------|                             |                       |
      |                           |                             |                       |
```

> The Okta System Log records: Caller identity, A2A token issuance, resource invocation, and provisioning actions — a complete chain-of-delegation audit trail.

---

## 6. Runtime Payoff

Once the auto-role agent has provisioned the custom role, resource set, and binding for a user, the platform-layer enforcement is live. Here is how the runtime payoff plays out in an agentic request.

### The ID-JAG exchange

When the user-facing agent needs to act on a user's behalf, it performs a token exchange (Cross-App Access / XAA):

1. The user authenticates to the user-facing agent via OIDC and receives an `id_token`.
2. The agent exchanges the `id_token` for an **ID-JAG** (Identity Assertion Authorization Grant) at Okta's token exchange endpoint.
3. The agent exchanges the ID-JAG for an **Okta management access token** from the custom authorization server, requesting the group management scopes (`okta.groups.read`, `okta.groups.members.manage`).
4. Okta evaluates the token request against the user's **custom admin role + resource set binding** (provisioned by this agent). The resulting token carries the user's constrained admin context.

### What scoping means at runtime

The token produced in step 4 is *platform-scoped* to the user's owned groups. When the user-facing agent (or the official Okta MCP server) calls the Okta Groups API with this token:

- `GET /api/v1/groups` returns only the groups in the user's resource set.
- `PUT /api/v1/groups/{id}/users/{userId}` succeeds only if the group is in the resource set.
- Attempts to manage groups outside the resource set return 403 at the Okta API layer — no application-level gate required.

### The official Okta MCP server path

Because enforcement is at the token level, the user-facing agent can optionally be replaced by (or supplemented with) the **official Okta MCP server** for the actual group-management calls:

- The official Okta MCP server authenticates via Device Authorization Grant (interactive) or Private Key JWT (headless) and operates with the *application's* permissions.
- With ID-JAG: the agent performs a token exchange to get a user-scoped token, then passes it to the official MCP server — the server's operations are now bound by the user's resource set.
- The official MCP server does not need to know about group ownership. It just calls the Okta Groups API. The token does the enforcing.

**Important caveat (as of July 2026):** The official Okta MCP server documentation states it "acts with the authenticated application's permissions, not individual user permissions." The ID-JAG/XAA path is what makes it user-scoped. This requires XAA to be available and enabled on the tenant (see §11).

### ASCII Sequence Diagram — Runtime payoff (ID-JAG → scoped token → group action)

```
User                   User-Facing Agent          Okta (Org AS + Custom AS)     Okta Groups API
  |                          |                              |                          |
  |-- "add Alice to Eng" --->|                              |                          |
  |                          |                              |                          |
  |                          |-- exchange id_token -------->|                          |
  |                          |   for ID-JAG                |                          |
  |                          |<-- ID-JAG ------------------|                          |
  |                          |                              |                          |
  |                          |-- exchange ID-JAG ---------->|                          |
  |                          |   for mgmt access token     |                          |
  |                          |   (okta.groups.members.manage)                         |
  |                          |                              |                          |
  |                          |   [Okta checks user's        |                          |
  |                          |    custom role binding;      |                          |
  |                          |    resource set = {Eng-Team}]                          |
  |                          |                              |                          |
  |                          |<-- scoped access token ------|                          |
  |                          |   (bound to {Eng-Team} only) |                          |
  |                          |                              |                          |
  |                          |-- PUT /groups/{Eng-Team-id}/users/{AliceId} ----------->|
  |                          |   Authorization: Bearer <scoped token>                  |
  |                          |                              |                          |
  |                          |                              |          [Okta validates  |
  |                          |                              |           token resource  |
  |                          |                              |           set includes    |
  |                          |                              |           Eng-Team ✓]     |
  |                          |                              |                          |
  |                          |<-- 204 No Content -----------------------------------------+
  |<-- "Alice added to Eng Team" --|                        |                          |
  |                          |                              |                          |
  |  (Attempt on un-owned group)   |                        |                          |
  |-- "add Alice to Payroll" -->   |                        |                          |
  |                          |-- PUT /groups/{Payroll-id}/users/{AliceId} ----------->|
  |                          |                              |          [Payroll not in  |
  |                          |                              |           resource set → 403]
  |                          |<-- 403 Forbidden ----------------------------------------+
  |<-- "Access denied" ------|                              |                          |
```

---

## 7. Least-Privilege & Separation of Duties

### Why the provisioning agent is separate

The user-facing group-owner agent and the auto-role provisioning agent have categorically different privilege levels:

| Dimension | User-Facing Agent | Auto-Role Agent |
|---|---|---|
| Okta scopes | `okta.groups.read`, `okta.groups.members.manage`, `okta.users.read` | `okta.roles.manage`, `okta.groups.read`, `okta.users.read` |
| Can manage group members | Yes (only for owned groups) | No — reads group membership only for ownership enumeration |
| Can create/assign admin roles | No | Yes |
| Can create resource sets | No | Yes |
| Token source for user requests | ID-JAG exchange (user-scoped) | `client_credentials` (agent identity) |
| Activated by | A user session | An event signal or schedule |
| Talks to end users | Yes | No (headless) |

If the user-facing agent were also capable of assigning custom admin roles, a compromised or prompt-injected user-facing agent could escalate its own privileges by assigning itself broader roles. By splitting the function, a compromised user-facing agent cannot perform provisioning — it can only request that the provisioning agent perform work via a time-limited A2A token that the custom auth server will only issue if a valid resource connection exists.

### What each identity can and cannot do

**User-Facing Agent identity:**
- Can call Okta Groups API for membership operations on the user's owned groups (post ID-JAG).
- Can request an A2A token to invoke the auto-role agent (if a resource connection exists).
- Cannot create roles, resource sets, or role assignments.
- Cannot read or write group ownership (owners endpoints).

**Auto-Role Agent identity:**
- Can read all groups and owners (for reconciliation).
- Can create, update, and delete custom admin roles.
- Can create, update, and delete resource sets.
- Can assign and revoke custom role bindings.
- Cannot manage group members.
- Cannot exchange tokens on behalf of a user.
- Cannot read or modify user sessions.

**Okta Custom Auth Server:**
- Issues short-lived A2A tokens when a resource connection authorizes the caller.
- The resource connection policy is the gatekeeper — if the connection does not exist or is revoked, no A2A tokens are issued, and the auto-role agent is unreachable from the user-facing agent.

---

## 8. Reconciliation & Drift Handling

The auto-role agent's scheduled reconciliation run (Signal C in §3) is the source of truth enforcement. It must handle the following state transitions correctly.

### Ownership state machine

```
No owned groups                  One or more owned groups
       │                                   │
       │  ◄─── last group removed ─────────┤
       │                                   │
       │  ──── first group added ──────►   │
       ▼                                   ▼
No role assignment          Role assignment exists
No resource set             Resource set = {owned groups}
```

### Transition logic

| Event | Action |
|---|---|
| User gains first owned group | Create resource set; create role assignment binding custom role + resource set to user |
| User gains additional owned group | Add group to existing resource set (PATCH resource set) |
| User loses a group (but retains others) | Remove group from resource set (PATCH resource set) |
| User loses all owned groups | Revoke role assignment; delete resource set |
| Custom role is found missing or misconfigured | Re-create or update the role (idempotent) |
| Role assignment is found missing for a user who has owned groups | Re-create the binding |
| Duplicate role assignments found | Delete extras; retain one canonical binding |

### Idempotency requirements

Every operation the agent performs must be idempotent:

- Check for an existing role assignment before creating one.
- Check for an existing resource set before creating one.
- Use the stable naming convention (`group-owner-{userId}`) to detect existing resource sets by name.
- Treat 409 Conflict responses from the Okta Roles API as successful no-ops.

### Stale-index risk

The agent enumerates ownership via `GET /api/v1/groups/{id}/owners` (paginated over all groups). This is a live call to Okta, not a cached index, so the reconciliation sees authoritative state. The tradeoff is API quota consumption on large tenants — rate-limit headers must be respected and the enumeration must implement backoff.

### What triggers an out-of-band immediate reconciliation

- Signal A (event hook) fires for `group.assign_owner` or `group.remove_owner`.
- Signal B (workflow) calls the trigger endpoint.
- An admin calls a manual trigger endpoint on the crew (useful for debugging).

For out-of-band runs, the crew is scoped to the affected user only (not a full tenant scan), keeping latency low.

---

## 9. Security Considerations & Failure Modes

### Fail-closed posture

The agent must fail closed on all error paths:

- If the Okta Roles API is unavailable, the agent logs the error and does **not** create a partial assignment. A partial assignment (resource set without a role binding, or a role binding without the correct resource set) is worse than no assignment because it might be incorrectly interpreted as a valid state.
- If the A2A token request is denied (custom auth server rejects, resource connection absent, or connection expired), the user-facing agent receives an error and must not proceed with the privileged action. It should surface a clear error to the user: "Provisioning service unavailable — retry or contact an admin."
- If the reconciliation run cannot enumerate owners for a group (rate-limited, 403, etc.), that group is skipped. The resource set for affected users is not modified. The next scheduled run will retry.

### What happens if the custom auth server denies a token request

The A2A token request is denied if:
- The resource connection between the user-facing agent and the auto-role agent does not exist or is paused.
- The Caller's token does not carry the required scopes or identity claims.
- The custom auth server policy has an explicit deny for this Caller/Resource pair.

In all cases: the user-facing agent receives `401 access_denied`. It should not retry automatically (retry loops could exhaust quota). The system log records the denial with the Caller's identity, making it auditable.

### Auditability

Every action the auto-role agent takes produces an Okta System Log event:
- Custom role created / updated: `system.iam.role.create` / `system.iam.role.update`
- Resource set created / updated: `system.iam.resource-set.create` / `system.iam.resource-set.update`
- Role assigned / revoked: `user.account.privilege.grant` / `user.account.privilege.revoke`

The A2A token exchange itself produces a `token.issuance` event recording the Caller and Resource identities.

This chain — ownership change → A2A invocation → provisioning action — is fully traceable in the Okta System Log without any custom audit store.

### Threat model notes

- **Prompt injection** cannot escalate privilege through the user-facing agent because the user-facing agent does not hold role-assignment power. The best a prompt-injection attack can do is trigger a provisioning request, which the auto-role agent validates against actual Okta ownership state before acting.
- **Stolen A2A tokens** are time-bounded (short expiry set by the custom auth server policy) and resource-scoped (usable only against the auto-role agent's audience). A stolen A2A token cannot be used to call any other Okta API.
- **Private key compromise** for the auto-role agent identity is the highest-severity risk. The key is an `client_credentials` identity with `okta.roles.manage`. Rotation must be planned from day one. Store the key in SSM SecureString, audit access, and rotate on a schedule.
- **Resource set over-scoping** (accidentally adding groups to a resource set that the user does not own) would grant the user admin power over those groups. The reconciliation logic must derive resource set membership **exclusively** from the live Okta owner enumeration, never from tool arguments or user-supplied data.

---

## 10. Build Phases & Milestones

> This is a roadmap. Nothing in this section is built. Phase completion is not a commitment until the prerequisites in §11 are resolved.

### Phase 0 — Prerequisites & Proof of Concept (days 1–5)

- [ ] Confirm Okta A2A is enabled on `taskvantage.okta.com` (contact Okta SE/TAM).
- [ ] Confirm XAA / ID-JAG is available on the tenant and test a basic token exchange (the crewai-demo already proved `client_credentials`; this adds the user token exchange path).
- [ ] Provision a custom auth server (or verify the existing one in the demo environment can be extended with a resource registration for the auto-role agent).
- [ ] Call `GET /api/v1/iam/roles` and `POST /api/v1/iam/roles` manually with the SSWS key to confirm the Roles API accepts custom role creation on the tenant.
- [ ] Call `GET /api/v1/iam/resource-sets` and create a test resource set; assign it to a test user; verify the test user's admin token reflects the constraint.

### Phase 1 — Core Provisioning Crew (week 1–2)

- [ ] Scaffold the CrewAI crew under `environments/ai-agent-demo/auto-role-agent/` (mirroring `crewai-demo/`).
- [ ] Implement Okta API tools for: role read/create, resource set read/create/patch/delete, role assignment read/create/delete.
- [ ] Implement the desired-state computation: enumerate owners → compute delta against current resource set contents → apply.
- [ ] Implement the scheduled reconciliation mode (`--once` and `--watch` flags, same as crewai-demo).
- [ ] Provision the agent's Okta identity via Terraform (new `.tf` file in `environments/taskvantage-prod/terraform/`).
- [ ] Smoke test: trigger manually for a test user who owns two groups; verify resource set and role assignment appear correctly.

### Phase 2 — Event Hook Trigger (week 2–3)

- [ ] Build a lightweight webhook receiver (Lambda or FastAPI) that validates the Okta event hook signature and invokes the auto-role crew for the affected user.
- [ ] Configure an Okta Event Hook on `taskvantage.okta.com` for `group.assign_owner` and `group.remove_owner` (or the closest available event types).
- [ ] Test end-to-end: make a user a group owner in the Admin Console → hook fires → crew runs → resource set updated within ~10 seconds.

### Phase 3 — A2A Integration (week 3–4)

- [ ] Register the auto-role agent as a protected resource in the custom auth server.
- [ ] Expose an HTTP provisioning endpoint on the auto-role agent that validates A2A tokens.
- [ ] Configure a Manual resource connection in Okta between the user-facing group-owner agent (Caller) and the auto-role agent (Resource).
- [ ] Update the user-facing agent to request an A2A token and call the auto-role agent's provisioning endpoint when it detects an ownership gap.
- [ ] Verify the chain-of-delegation audit trail in the Okta System Log.

### Phase 4 — Official Okta MCP Server Integration (week 4–5, optional)

- [ ] Set up the official Okta MCP server against `taskvantage.okta.com`.
- [ ] Configure the user-facing agent to use the official MCP server for group calls, passing the ID-JAG-derived scoped token.
- [ ] Verify that the official MCP server respects the resource set constraint (attempt to manage an un-owned group; expect 403).
- [ ] This phase is optional — the group-owner-mcp server already works correctly. This is a "replace app-layer gate with platform gate" upgrade path.

### Phase 5 — Demo Polish & Runbook (week 5)

- [ ] Write the SE demo runbook showing the before/after: "without the auto-role agent, the MCP server enforces the gate in code; with it, the Okta token does the enforcing."
- [ ] Add smoke test assertions: resource set contents match owned groups; role assignment exists for every owner; role assignment absent for non-owners.
- [ ] Performance test the reconciliation against the full `taskvantage.okta.com` group set (currently 92 groups per MEMORY.md — trivial; document the scaling inflection point).

---

## 11. Open Questions & Prerequisites

These are unresolved items that must be answered before building can begin. They are not risks that code can work around.

### Critical prerequisites

**P1 — Okta A2A enablement on `taskvantage.okta.com`**

Okta A2A may require feature-flag enablement by Okta Support or a TAM. Verify the feature is on before designing the A2A connection registration flow. If A2A is not available, the agent can still provide value for Phases 1–2 (scheduled reconciliation and event hook trigger) without the A2A delegation path.

**P2 — XAA / ID-JAG availability on the tenant**

The runtime payoff in §6 depends on Cross-App Access (XAA) being enabled and functioning on `taskvantage.okta.com`. The architecture.md confirms this is the intended token-exchange path, but XAA must be empirically tested (the crewai-demo proves the `client_credentials` path only; the user ID-JAG exchange is a different code path). Unblock this in Phase 0.

**P3 — Custom authorization server with resource registration capability**

A custom auth server must exist (not the Org Authorization Server). The existing demo environment uses `aus22dp8l2sy5rBv21d8` for the crewai-demo crew. Whether that server can also host the auto-role agent resource registration, or whether a separate server is needed, is an open question. Verify with the custom auth server's policy configuration.

**P4 — Roles API permission on the agent's service app**

Confirm that the `okta.roles.manage` scope can be granted to an API Services app on this tenant, and that the custom auth server will issue tokens with that scope. Some Okta tenants restrict who can manage roles. Test with a manual SSWS call in Phase 0 before wiring automation.

### Open design questions

**Q1 — One resource set per user, or one per user-group pairing?**

This spec proposes one resource set per user (named `group-owner-{userId}`) containing all the user's owned groups. The alternative is one resource set per user-group pair. The per-user model is simpler and has lower API overhead; the per-group model allows more granular binding (e.g., different roles per group). The per-user model is the proposed default — revisit if granular role-per-group binding is needed.

**Q2 — Behavior when the auto-role agent's token is expired during a long reconciliation run**

The `client_credentials` token has a 1-hour lifetime. If a full reconciliation takes longer than an hour (unlikely at 92 groups, but possible at scale), the token must be re-minted mid-run. The crewai-demo re-mints on each watch-loop pass; this crew should do the same for each major operation batch.

**Q3 — What Okta event types fire for ownership changes?**

The event hook path (Signal A) depends on the correct Okta system event type being available. Candidate types: `group.user_membership.add_initiator`, `group.assign_owner`. Empirically verify on the tenant before configuring the hook.

**Q4 — Multi-instance deployment**

The group-owner-mcp plan flags that a multi-instance deployment of the MCP server would need a shared store for the owner index. The same consideration applies to the auto-role agent's reconciliation state: if two crew instances run concurrently, they could race on resource set updates. For Phase 1, single-instance is acceptable. For production, add a distributed lock (e.g., DynamoDB conditional writes or Redis `SET NX`) around the per-user provisioning block.

**Q5 — How the official Okta MCP server handles user-scoped tokens**

The official Okta MCP server documentation (as of July 2026) states it "acts with the authenticated application's permissions, not individual user permissions." The ID-JAG path is expected to make it user-scoped, but this needs empirical validation on the tenant before Phase 4 is committed. If user-scoped tokens are not honored by the official MCP server's Groups tool, Phase 4 is deferred indefinitely and the group-owner-mcp server remains the enforcement point.

---

*This document is a proposal. No code exists. Implementation depends on tenant-level prerequisites (§11). The architecture is grounded in publicly documented Okta A2A and XAA capabilities; any capability listed here reflects the documented Okta feature set as of July 2026, not local customization.*
