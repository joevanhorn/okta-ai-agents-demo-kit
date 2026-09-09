# group-owner-mcp

A trimmed, standalone MCP server that lets a user manage the Okta groups they own through
an AI agent — without holding any Okta admin role. It is a demo component of the
**Okta for AI Agents** story. The core design point is that security is not enforced by
careful bot prompting; it is enforced by identity-layer controls the LLM cannot influence.
The verified `sub` claim from the caller's bearer token is the only source of "who is asking,"
and a fail-closed ownership gate blocks every access to any group the caller does not own —
regardless of how the AI is instructed.

## The Two Demo Goals

| # | Goal |
|---|------|
| 1 | A user can pull and manage the membership of groups they own through natural language. |
| 2 | A user cannot see or touch any group they do NOT own — regardless of how the agent is prompted. |

## How Security Is Enforced: Four Additive Layers

Each layer independently enforces the boundary. Nothing below depends on a layer above it
being present.

| Layer | What enforces it | Needs FGA? | Status |
|-------|-----------------|------------|--------|
| **1 — Verified identity** | Caller identity is taken from the validated bearer token `sub` claim, never from a tool argument. Server verifies against org JWKS (defense in depth; adapter also validates). No prompt can change who the caller is. (`src/identity.ts`) | No | Shipped |
| **2 — App-layer ownership gate** | `assertCallerOwnsGroup(subject, groupId)` in `src/policy/ownership.ts` calls Okta's group-owner API as the authority, fail-closed, before any read or write. This is the complete standalone enforcement story. | No | Shipped (this is the spine) |
| **3 — Okta FGA (optional)** | Same choke point, but the decision is externalized to Okta FGA: ownership becomes `user:<id> owner group:<id>` relationship tuples, centrally auditable. Enable with `FGA_ENABLED=true`. With it off, Layer 2 still fully enforces — FGA is never load-bearing for correctness. | Yes | Shipped (opt-in) |
| **4 — Custom Admin Roles + Resource Sets + ID-JAG** | Owner holds a scoped Okta custom admin role. Via ID-JAG (Cross-App Access), the agent exchanges the user's identity assertion for a management token that inherits those constraints. The Okta API itself only returns/permits the owned groups. At this layer the official Okta MCP server can be used directly; enforcement is at the data layer. | No | **ROADMAP** |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical treatment of each layer.

## Tools

| Tool | Arguments | What it does |
|------|-----------|-------------|
| `list_my_owned_groups` | _(none)_ | Returns the groups the verified caller owns. Group list is scoped to the caller's identity — the caller cannot specify a different subject. |
| `list_owned_group_members` | `groupId` (string), `limit` (number, optional) | Returns the members of a group the caller owns. Ownership is verified before Okta is contacted. |
| `manage_owned_group_membership` | `groupId` (string), `userId` (string), `action` (`check` \| `add` \| `remove`) | Checks, adds, or removes a member. Never modifies group ownership — members only. Ownership is verified before any mutation. |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your local config
cp .env.example .env
# Fill in OKTA_DOMAIN, OKTA_CLIENT_ID, OKTA_PRIVATE_KEY_PATH
# (See .env.example for all options; FGA is optional.)

# 3. Run in development mode
npm run dev
# Server starts on PORT (default 8080)

# 4. Run tests (including the red-team suite)
npm test
```

### Required: Okta service app

The server uses private-key JWT client credentials to call the Okta API on behalf of users.
Create a service app in your Okta tenant with the following scopes granted:
`okta.groups.read`, `okta.groups.manage`, `okta.users.read`.

### Optional: Okta FGA (Layer 3)

```bash
# Sync Okta group owners → FGA ownership tuples
npm run sync-fga

# Then restart with FGA enabled
FGA_ENABLED=true npm run dev
```

## Proving Goal #2 (Red-Team Suite)

```bash
npm test
# runs test/red-team.test.ts
```

The red-team tests issue adversarial tool calls — cross-user group access, attempts to pass a
different subject in arguments, escalation via natural-language arguments — and assert that
every call is denied before reaching Okta. To demonstrate Layer 2 independence, disable FGA
and rerun: all denials hold.

## Further Reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — threat model, layer-by-layer code paths, ASCII data-flow diagram, Layer 4 / ID-JAG deep dive
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — 15-minute SE demo script, happy-path and adversarial acts with talking points
