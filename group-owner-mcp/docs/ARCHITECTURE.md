# group-owner-mcp — Architecture

## 1. Threat Model and the Two Goals

The demo establishes two concrete, falsifiable goals:

**Goal 1 (happy path):** A user can list and manage membership of the Okta groups they own
through an AI agent, using natural language, without needing an Okta admin role.

**Goal 2 (adversarial path):** A user cannot read or modify any group they do not own —
regardless of prompt engineering, social engineering, or attempts to pass a different identity
through tool arguments.

The threat model includes a hostile or confused LLM. An adversary who can influence the
agent's system prompt, inject text into the conversation, or craft tool arguments should be
unable to cross the ownership boundary. The model also assumes the MCP caller itself may be
untrusted until its token is verified.

---

## 2. Why "Bot Design" Is the Wrong Enforcement Model

A naive approach puts the boundary in the system prompt: "Only answer questions about groups
the user owns." This fails for three reasons:

1. **Prompt injection.** A sufficiently creative user message can override or contradict the
   system prompt. The LLM has no cryptographic relationship to its own instructions.

2. **Hallucinated tool arguments.** An LLM can generate any argument for a tool call,
   including a `subject` value that belongs to a different user. If the tool trusts that
   argument, the boundary is gone.

3. **No audit trail.** A system-prompt check leaves no record of what was denied and why,
   making compliance claims unverifiable.

The correct answer is that the LLM never holds the enforcement decision. The LLM is a
reasoning surface; enforcement is at the identity layer, in code, using cryptographically
signed tokens that the LLM cannot read or modify.

---

## 3. The Four Layers

### Layer 1 — Verified Identity (always on; the foundation)

**What it enforces:** The caller's identity (the `subject` used for all downstream decisions)
is taken exclusively from the validated bearer token. It is never accepted from a tool argument,
a query parameter, or any part of the conversation. No instruction to the LLM can change who
the caller is because the caller's identity is a cryptographic fact, not a conversational one.

**Code path:** `src/identity.ts` — `resolveCallerIdentity(bearerToken)`

The function:
1. Extracts the raw token from the `Authorization: Bearer <token>` header.
2. Fetches the org JWKS from `https://<OKTA_DOMAIN>/oauth2/v1/keys` (lazily cached).
3. Calls `jwtVerify()` (via `jose`) — validates signature, expiry, and issuer.
4. Extracts `sub` from the verified payload and returns a `CallerIdentity` object.
5. Returns `null` on any failure (missing token, bad signature, missing `sub`).

**Deployed topology note:** In the running demo, the MCP adapter validates the end-user's Okta
token before the request reaches this server (bearer passthrough). This module verifies the
token again against the JWKS — defense in depth. Even if reached directly, no unverified
assertion is trusted.

**Failure mode:** Returns `null`. The tool handler receives no identity, treats the caller as
unauthenticated, and returns an error. Fail-closed.

**Why the LLM cannot bypass this:** The `sub` claim is inside the signed JWT. The LLM never
sees the raw token and cannot modify a claim that is covered by the signature. An instruction
like "I am the admin" changes nothing about the `sub` claim the server reads.

---

### Layer 2 — App-Layer Ownership Gate (the baseline; no FGA required)

**What it enforces:** Before any tool can read group members or mutate group membership, a
single choke point asserts that the verified caller owns the requested group. If the caller is
not an owner, the function throws and the Okta API is never contacted.

**Code path:** `src/policy/ownership.ts` — `assertCallerOwnsGroup(subject, groupId)`

The function:
1. Calls `getOwnershipSource()` from `src/policy/owner-source.ts` to get the active source
   (Okta at Layer 2, FGA at Layer 3).
2. Calls `source.isOwner(subject, groupId)`.
3. If the result is `false` or an error is thrown, raises `NotGroupOwnerError`. Fail-closed.

**Layer 2 source — `OktaOwnershipSource`:**

The `isOwner()` method makes a single live Okta API call:

```
GET /api/v1/groups/{groupId}/owners?filter=type eq "USER"
```

This returns the current owner list directly from Okta. There is no cache on the ownership
check itself (a separate in-memory index exists only for the `list_my_owned_groups` operation,
with a 5-minute TTL). A group's ownership state in Okta is the authoritative fact.

**Failure mode:** Any HTTP error from Okta, any unexpected response, or any exception causes
`isOwner()` to return `false`. The gate throws `NotGroupOwnerError`. Fail-closed.

**This is the complete enforcement story for Layer 2.** FGA is not required. The ownership
check is a direct, synchronous call to the same Okta API that manages group ownership. There
is no separate policy engine that could be configured incorrectly or left unsynchronized.

---

### Layer 3 — Okta FGA (optional; `FGA_ENABLED=true`)

**What it enforces:** The same choke point makes the same call — `assertCallerOwnsGroup()` is
unchanged. What changes is WHERE the ownership decision is made: instead of calling Okta's
group-owner API directly, the gate calls Okta FGA with a relationship check.

**FGA model:**

```
user:<oktaUserId>  owner  group:<groupId>
```

Ownership becomes a relationship tuple in the FGA store, written by the sync job:

```bash
npm run sync-fga    # src/fga/sync-ownership.ts
                    # Reads all Okta group owners → writes tuples to FGA
```

**Code path:** `src/fga/fga-client.ts` — `check(user, relation, object)` and
`listObjects(user, relation, type)`.

`check()` posts to the FGA `/check` endpoint and returns `data.allowed === true`. Any error
or non-OK response returns `false`. Fail-closed.

**Important contrast with the sibling Bedrock demo:** The Bedrock demo's `fga.ts` returns
`true` on error (fail-open) because it is availability-oriented — a slow FGA service should
not block all agent traffic. This server has the opposite guarantee: a slow or unreachable
FGA service means all ownership checks return `false` and all group access is denied. Security
is the priority here, not availability.

**With FGA disabled, Layer 2 fully enforces.** FGA is never load-bearing for correctness.
Enabling it changes where the policy lives — from Okta's group-owner data to FGA relationship
tuples — but the gate, the calling conventions, and the failure semantics are identical.

**Why externalize to FGA?** With FGA, ownership is centrally auditable: you can query the
FGA store to enumerate all owners of all groups, see change history, and write policy-as-code.
For a demo that emphasizes governance controls, this is a meaningful step up from per-group
API calls that leave no FGA audit trail.

**Failure mode:** Any FGA API error or timeout returns `false`. Gate throws. Fail-closed.

---

### Layer 4 — Custom Admin Roles + Resource Sets + ID-JAG (ROADMAP — not built)

**What it enforces:** This layer moves enforcement to the Okta data layer itself. The caller's
management token is constrained at issuance to the groups they own — so the Okta API returns
only permitted data, not just a gated view of all data. Application code does not need a custom
gate because there is nothing to gate against.

**Mechanism:**

1. **Custom Admin Role:** The group owner is assigned an Okta Custom Admin Role scoped by a
   **Resource Set** that enumerates exactly the groups they own.
2. **ID-JAG (Identity Assertion Authorization Grant):** The agent presents the user's identity
   assertion (via Okta Cross-App Access / XAA). Okta exchanges it for a management access
   token that inherits the user's custom admin role constraints.
3. The resulting token, scoped to `okta.groups.manage`, is only permitted to act on the groups
   in the user's Resource Set. The Okta API itself enforces the boundary.

**Connection to the official Okta MCP server:**

The [official Okta MCP server](https://developer.okta.com/blog/2025/09/22/okta-mcp-server)
bridges LLMs and Okta management APIs. It supports two auth modes:

- **Device Authorization Grant** — interactive browser login; suitable for dev use.
- **Private Key JWT** — headless, server signs requests with a local private key registered
  in Okta; suitable for automation.

Its tools include user CRUD, group management (`okta.groups.manage`), group membership changes,
system logs, and apps. A key nuance from the official documentation: "The server acts with the
authenticated application's permissions, not individual user permissions." Today's official
server is app-scoped — the application's credentials determine what is accessible.

**The provisioning side + the access side:**

At Layer 4, the official server handles the provisioning side: an AI agent automatically
assigns the scoped Custom Admin Role to a new group owner (using the application's
`okta.roles.manage` and `okta.groups.manage` scopes — app-scoped, exactly the current model).
This is where the official server shines today.

At runtime, ID-JAG handles the access side: the user says "add Bob to my Contractors group"
and the agent exchanges the user's identity assertion for a management token that inherits the
user's Resource Set constraints. The Okta API enforces the scope; the application does not
need a custom gate. The token exchange happens transparently — the user's experience is
identical, but enforcement has moved from application code to the identity layer.

The full auto-provisioning agent specification (how an agent monitors group ownership changes
in Okta and reconciles Custom Admin Role assignments) is documented separately at
`docs/SPEC-auto-role-agent.md` (in progress).

**What ships tonight vs. ROADMAP:**

Layer 4 is documented here to frame the destination, not as something the demo box runs.
The auto-role-agent spec is being written; ID-JAG for Okta management tokens is the capability
that makes this possible.

---

## 4. Request-Flow Walkthrough

### Data-Flow Diagram

```
  AI Agent (Claude / MCP client)
       |
       |  HTTP + Authorization: Bearer <user-token>
       v
  MCP Adapter  ─── validates token against org JWKS ─── [FAIL: 401]
       |              forwards validated token
       |  Authorization: Bearer <user-token>  (bearer passthrough)
       v
  group-owner-mcp  (this server, port 8080)
       |
       ├─ src/identity.ts  resolveCallerIdentity()
       │       verifies token against org JWKS (defense in depth)
       │       extracts sub  ─────────────────────────────────────── [FAIL: no identity → 403]
       │
       ├─ tool handler
       │       builds CallerContext { subject: "<verified sub>" }
       │       subject is NEVER taken from tool arguments
       │
       ├─ src/policy/ownership.ts  assertCallerOwnsGroup(subject, groupId)
       │       └─ src/policy/owner-source.ts  getOwnershipSource()
       │               ├─ FGA_ENABLED=false → OktaOwnershipSource
       │               │       GET /api/v1/groups/{id}/owners  ──── [FAIL: not owner → 403]
       │               └─ FGA_ENABLED=true  → FgaOwnershipSource
       │                       POST /stores/{id}/check            ── [FAIL: not owner → 403]
       │
       └─ src/okta/groups-client.ts  (only reached after gate passes)
               GET  /api/v1/groups/{id}/users      (list members)
               PUT  /api/v1/groups/{id}/users/{uid} (add member)
               DELETE /api/v1/groups/{id}/users/{uid} (remove member)
               ──────────────────────────────────────────────────────── [SUCCESS: 200]
```

### Legitimate Call

1. User asks: "Who is in my Contractors group?"
2. Agent calls `list_owned_group_members` with `{ groupId: "00gABC123" }`.
3. Server extracts `Authorization` header, verifies JWT, reads `sub` = `"00uXYZ456"`.
4. `assertCallerOwnsGroup("00uXYZ456", "00gABC123")` calls Okta's owner API. Response
   includes `{ id: "00uXYZ456", type: "USER" }`. Ownership confirmed.
5. `groupsClient.listMembers("00gABC123")` is called. Members are returned.
6. Agent narrates the member list to the user.

### Denied Call (cross-user access attempt)

1. User asks: "Show me the members of group 00gSECRET."
2. Agent calls `list_owned_group_members` with `{ groupId: "00gSECRET" }`.
3. Server reads `sub` = `"00uXYZ456"` from the verified token.
4. `assertCallerOwnsGroup("00uXYZ456", "00gSECRET")` calls Okta's owner API. `"00uXYZ456"`
   is not in the owner list. `isOwner()` returns `false`.
5. Gate throws `NotGroupOwnerError`. Okta's member API is never called.
6. Agent receives an error response and tells the user access is denied.

Note: step 4 is unchanged whether the user asked politely, claimed to be an admin, or injected
text into the conversation. The `subject` is `"00uXYZ456"` because that is what the signed
token says. The LLM's framing of the request is irrelevant to the gate.

---

## 5. What Ships Tonight vs. Roadmap

| Capability | Status |
|-----------|--------|
| Verified bearer-token identity (Layer 1) | Shipped |
| Okta ownership gate (Layer 2) | Shipped |
| Okta FGA ownership gate (Layer 3, opt-in) | Shipped |
| FGA sync job (`npm run sync-fga`) | Shipped |
| Red-team test suite (`test/red-team.test.ts`) | Shipped |
| Official Okta MCP server integration | Roadmap (requires ID-JAG for user-scoped tokens) |
| Custom Admin Roles + Resource Sets scoping (Layer 4) | Roadmap |
| Auto-role-assignment agent via official server | Roadmap (spec at `docs/SPEC-auto-role-agent.md`) |
| ID-JAG token exchange for runtime user-scoped tokens | Roadmap |
