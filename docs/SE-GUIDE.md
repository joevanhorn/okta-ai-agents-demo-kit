# Okta AI Agents Demo Kit: SE Guide and Best Practices

This guide is for Solutions Engineers on the AI strike team. It explains what each
component in this kit does, how the pieces fit together, how to run the demos, and
the practices worth carrying into customer conversations. Everything here was
verified against the code as packaged; where a component has a known sharp edge,
it is called out rather than papered over.

Contents:

1. [The architecture in one page](#1-the-architecture-in-one-page)
2. [Connection models: adapter vs. resource server](#2-connection-models-adapter-vs-resource-server)
3. [Component: the backend MCP server](#3-component-the-backend-mcp-server-mcp-server)
4. [Component: the CrewAI Account Risk Monitor](#4-component-the-crewai-account-risk-monitor-crewai-demo)
5. [Component: the simulation workflow](#5-component-the-simulation-workflow)
6. [Component: group-owner-mcp](#6-component-group-owner-mcp)
7. [Demo playbooks](#7-demo-playbooks)
8. [Best practices](#8-best-practices)
9. [Known sharp edges (read before you present)](#9-known-sharp-edges-read-before-you-present)
10. [Environment reference](#10-environment-reference)

---

## 1. The architecture in one page

Every component in this kit demonstrates the same thesis from a different angle:
**what an AI agent is allowed to do should be enforced by the identity layer, not
by the system prompt.** A prompt can be injected, an argument can be forged, and
a model can hallucinate. An OAuth policy, an ownership check, or an FGA tuple
cannot be talked out of its decision.

The enforcement stack, bottom to top:

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (CrewAI crew, Claude, any MCP client)                │
└──────────────┬──────────────────────────────────────────────┘
               │ Bearer token (scoped by Okta policy)
┌──────────────▼──────────────────────────────────────────────┐
│  Layer 1: Okta OAuth scopes → tool VISIBILITY               │
│  tools/list is filtered per token. A tool the agent has no  │
│  scope for does not exist as far as the agent is concerned. │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: app-layer authorization → tool BEHAVIOR           │
│  e.g. group-owner-mcp's ownership gate: even a visible tool │
│  refuses to touch a group the caller does not own.          │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Okta FGA → per-call and per-record access         │
│  can_invoke_read / can_invoke_write checks per tool, and    │
│  viewer/owner filtering of the records in each result.      │
└─────────────────────────────────────────────────────────────┘
```

The layers are independent, and that independence is itself a demo beat: the
group-owner-mcp red-team suite runs with FGA turned off to prove Layer 2 alone
holds the line, and the CrewAI smoke test proves Layer 1 alone keeps write tools
out of an agent's hands.

A useful one-liner for customers, taken from `grant_agent_fga.py`:

> Okta scopes gate *which tools are visible*; Okta FGA gates *whether a specific
> call or record is allowed*.

## 2. Connection models: adapter vs. resource server

Okta for AI Agents supports two ways for an agent to reach an MCP server, and
picking the wrong one is the most common way a demo dies. This kit's components
deliberately use both.

**Adapter model (user context).** An interactive agent (Claude, Claude Code, a
chat UI) connects through the Okta MCP adapter. The adapter runs the OAuth flow
itself, binds the session to a human user, and forwards a verified token to the
backend. Use this when the story is "the agent acts as Joe, with Joe's access."
Important constraint: the adapter mints its own tokens and **rejects tokens
acquired elsewhere**, so you cannot hand it a pre-minted bearer token.

**Resource server model (agent's own identity).** A headless, autonomous agent
(the CrewAI monitor here) is registered in Okta as an API Services app. It mints
its own token with `client_credentials` + `private_key_jwt` and calls the backend
MCP server **directly, bypassing the adapter**. The Okta authorization server
policy attached to that client decides its scope ceiling. Use this when the story
is "the agent is a first-class identity with its own least-privilege access."

Rule of thumb: user in the loop, go through the adapter; nobody at the keyboard,
resource server. Trying to push a headless agent's token through the adapter
fails by design, and that failure is worth showing customers on purpose.

## 3. Component: the backend MCP server (`mcp-server/`)

TypeScript, Node 22, official MCP SDK, Express. This is "SuperSafe-AI", the
resource server that both the CrewAI crew and adapter-connected agents call. It
fronts a real Salesforce dev org and a real ServiceNow PDI (there is no mock
mode; seeded demo data plays that role, see §5).

### Tools (14)

| Salesforce | Scope | ServiceNow | Scope |
|---|---|---|---|
| `search_accounts` | `sfdc:read` | `search_incidents` | `snow:read` |
| `get_account_details` | `sfdc:read` | `get_incident` | `snow:read` |
| `search_opportunities` | `sfdc:read` | `list_my_incidents` | `snow:read` |
| `list_contacts` | `sfdc:read` | `search_enhancements` | `snow:read` |
| `create_opportunity` | `sfdc:write` | `create_incident` | `snow:write` |
| `update_opportunity` | `sfdc:write` | `update_incident` | `snow:write` |
| `log_activity` | `sfdc:write` | `add_work_note` | `snow:write` |

`search_enhancements` reads `ENH*` records out of the incident table, with votes
and product area parsed from the description text (a lightweight way to demo a
"product feedback" tool without another system).

### How a request is authorized

1. **Scope extraction** (`src/auth.ts`). Three header cases:
   - No `Authorization` header: all four scopes (local stdio use with Claude Code).
   - `ApiKey <key>` matching `SERVICE_API_KEY`: all scopes (first-party services
     like the Bedrock Lambda).
   - `Bearer <jwt>`: the payload is decoded (not signature-verified; the server
     trusts the adapter or Okta to have verified it, see §9) and `scp`/`scope`
     is intersected with the four known scopes.
2. **Tool filtering** (`src/tools/registry.ts`). `tools/list` only returns tools
   whose `requiredScope` is present, and `tools/call` re-checks on every
   invocation, so a client cannot call a tool it was never shown.
3. **FGA invocation check** (`src/fga.ts`). When a user identity is resolvable
   from the token, the server checks
   `user:<email> can_invoke_read|can_invoke_write tool:<name>` against OpenFGA.
4. **FGA record filtering.** On the SSE/stdio path, result lists (accounts,
   opportunities, incidents) are filtered by `viewer` tuples before being
   returned. Note this filtering does not run on the JSON-RPC `POST /mcp` path
   (see §9).

### FGA model

Five types: `user`, `team` (member), `tool` (can_invoke_read/write),
`sfdc_account` (owner, viewer, editor), `snow_incident` (assignee, viewer,
editor). `viewer` and `editor` are unions that include `owner`/`assignee`, and
grants accept individual users, `user:*`, and `team#member` usersets. The full
model plus 67 seed tuples live in `scripts/setup_fga.py`, which is idempotent and
finishes with seven self-verification checks.

### The OIG-to-FGA bridge (`scripts/fga_webhook.py`)

This script is the governance story: an OIG access request is approved, Okta adds
the user to a `Cowork-*` group, a `group.user_member.add` event hook fires, and a
Lambda translates the group into FGA tuples. On the next MCP call the user's
access has changed, with the request/approval audit trail living in Okta. It also
has a CLI mode (`--action grant|revoke --user <email> --level crm-read|...`) for
demoing the same transition by hand.

### Running and deploying

- Local: `npm install`, set the env vars in `.env.example`, `TRANSPORT=http npx tsx src/index.ts`.
  Endpoints: `GET /health`, `POST /mcp` (JSON-RPC), `GET /sse` + `POST /messages`
  (legacy SSE), `POST /api/tool` (REST shim used by the Bedrock Lambda).
- Container: two-stage `Dockerfile`, listens on 3000. The live deployment is ECS
  Fargate behind an ALB at `https://mcp.supersafe-ai.io/mcp`, deployed by the
  `supersafe-ai-webapp-deploy.yml` workflow in the source monorepo
  (`-f action=deploy-mcp-server`).
- Okta side: auth server "MCP Adapter Auth Server", audience
  `https://mcp.taskvantage.ai`, the four scopes above plus `mcp:read` for the
  adapter, and groups `Cowork-{CRM,ITSM}-{Read,Write}` driving the access policy.

## 4. Component: the CrewAI Account Risk Monitor (`crewai-demo/`)

Python + CrewAI. A sequential three-agent crew that runs with **no human in the
loop** and authenticates as itself:

1. **Incident Watcher** finds open P1/P2 incidents (`list_my_incidents`,
   `search_incidents`, `get_incident`).
2. **Account Correlator** maps affected customers to Salesforce accounts and sums
   the open pipeline at risk.
3. **Risk Reporter** writes a ranked "Account Risk Briefing". In `--act` mode it
   is allowed exactly one write: `log_activity` on the highest-risk account.

### Identity flow (`okta_auth.py`)

The crew builds an RS256 client assertion (`iss` = `sub` = client ID, `aud` =
token URL, 5-minute expiry, `kid` from `OKTA_KEY_ID`) and posts it to the custom
authorization server's token endpoint with `grant_type=client_credentials` and
`scope=sfdc:read sfdc:write snow:read`. The private key is resolved in priority
order: `OKTA_PRIVATE_KEY_FILE`, then `OKTA_PRIVATE_KEY_PEM`, then SSM
(`/taskvantage-prod/crewai-monitor/private-key`, us-east-2). The resulting token
goes into the `Authorization` header of CrewAI's `MCPServerAdapter`
(streamable-http) pointed straight at `MCP_BACKEND_URL`.

The Okta side is Terraform
(`environments/taskvantage-prod/terraform/crewai_monitor.tf` in the monorepo): an
API Services app with an inline JWKS, plus a client-whitelisted policy and rule on
the shared auth server granting `sfdc:read sfdc:write snow:read` with a 60-minute
token lifetime. `snow:write` is deliberately absent. That single omitted scope is
the whole demo: the three ServiceNow write tools never appear in the crew's
`tools/list`, and `monitor_crew.py` prints a warning if they ever do.

### Running it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # defaults point at the live taskvantage demo env
python smoke_test.py    # no LLM key needed; proves token + scope filtering
python run.py --once    # one full pass (needs ANTHROPIC_API_KEY or LiteLLM)
python run.py --watch --interval 300
python run.py --once --act   # allows the single log_activity write
```

`smoke_test.py` is the free, deterministic proof: it mints a token, prints the
granted scopes, lists the visible tools, and **fails if any `snow:write` tool is
present**. Run it before every demo. The LLM defaults to Claude Haiku via
CrewAI's LiteLLM layer; a LiteLLM proxy is supported via `LITELLM_API_BASE` +
`LITELLM_API_KEY`.

A recorded run and expected output live in `sample_output.md` and `RUNBOOK.md`.

## 5. Component: the simulation workflow

A monitor with nothing to find makes a boring demo. Two scripts plus a scheduled
GitHub workflow keep the storyline alive.

**`simulate_activity.py`** opens realistic P1/P2 ServiceNow incidents (SSO
failures, MFA issues, API rate limiting, provisioning sync, latency) against a
weighted pool of five at-risk accounts that already carry open Salesforce
pipeline. Details that matter:

- It writes directly to the ServiceNow table API with basic auth; MCP and Okta
  are not involved in seeding.
- It allocates incident numbers in `INC-4600..INC-4999`, clear of the fixed seed
  set `INC-4498..4521`, because the backend's read tools are fenced to
  `INC-4xxx` records.
- ServiceNow derives `priority` from impact × urgency, so the script sets those
  two fields rather than priority itself.
- After creating each incident it grants the monitor agent
  (`user:<client-id>`, since a client_credentials token's `sub` is the client ID)
  an FGA `viewer` tuple on it. Without that grant the backend's FGA layer would
  filter the incident out and the crew would report all-clear.
- `--resolve-keep N` auto-resolves older simulated incidents so the instance
  doesn't fill up. `--mode dry-run` previews everything.
- Credentials: flags, then env, then SSM under `/bedrock-xaa-demo` (us-east-2)
  with `--use-ssm`.

**`grant_agent_fga.py`** is the one-time agent onboarding: it grants the monitor
`can_invoke_read` on all eight read tools, `viewer` on the five accounts, and
(with `--write`) the write-tool and `editor` tuples needed for `--act` demos. It
also backfills `viewer` on existing incidents. Run it whenever you stand up a new
agent identity or a new FGA store.

**`.github/workflows/simulate-activity.yml`** runs the simulator every 6 hours
and on manual dispatch (with account/priority/count/mode inputs). It uses GitHub
OIDC to assume an AWS role and pulls all backend credentials from SSM, so the
workflow needs exactly one secret: `AWS_ROLE_ARN`. If you fork this repo and want
the schedule live, create a matching GitHub environment and add this repo's OIDC
subject to the role's trust policy (new repos emit a different `sub` claim than
the repo the role was originally trusted for).

## 6. Component: group-owner-mcp (`group-owner-mcp/`)

A small standalone MCP server (TypeScript, Express + jose, no SDK dependency)
built to answer one customer question: *"can a non-admin safely manage groups
through an AI agent?"* A group **owner** gets exactly three tools:

- `list_my_owned_groups`
- `list_owned_group_members`
- `manage_owned_group_membership` (check/add/remove a member)

There is no tool, argument, or code path that touches group owners, other users'
groups, or any admin API. The denial message for a non-owned group is identical
to the not-found message, so the tools can't be used to enumerate groups.

### The layered gate

- **Layer 1, caller identity:** the bearer token is verified against the org
  JWKS (issuer-checked) and the subject comes from the verified `sub`. Tool
  arguments are never trusted for identity; the red-team suite includes forged
  `subject`/`actor`/`isAdmin` arguments and proves they are ignored.
- **Layer 2, ownership (always on):** `assertCallerOwnsGroup()` consults Okta's
  group owners API before any member operation, fail-closed. The Okta service
  identity is a private_key_jwt API Services app with only `okta.groups.read`,
  `okta.groups.manage`, `okta.users.read`.
- **Layer 3, FGA (optional):** flip `FGA_ENABLED=true` to source ownership from
  FGA tuples instead; `npm run sync-fga` mirrors Okta owners into the store.
  Turning it off mid-demo and rerunning the denial is a great way to show the
  layers are independent.

### Demo assets

- `npm run mock` + `scripts/claude-client.py`: a fully offline two-terminal demo
  (no Okta, no credentials; the mock accepts the bearer value as the subject so
  you can switch personas instantly).
- `npx tsx scripts/demo.ts`: a narrated two-act walkthrough, no server needed.
- `npm test`: an 11-test red-team suite (foreign-group reads/writes, forged
  identity args, injection-style IDs, "I'm an admin" appeals) that also asserts
  no Okta write fires on a denial.
- `docs/RUNBOOK.md`: a scripted 15-minute customer demo, happy path then attack
  path. `docs/recordings/` has ready-to-play captures of both.
- `docs/ARCHITECTURE.md`: the threat model and layer-by-layer design, written to
  be shown to customers.
- `docs/SPEC-auto-role-agent.md`: a design (not built) for a provisioning agent
  that grants owners a scoped custom admin role automatically; useful as a
  roadmap conversation piece.

## 7. Demo playbooks

**"Scopes are the seatbelt" (5 min, free).** Run `crewai-demo/smoke_test.py`.
Show the minted scopes, the 11 visible tools, and the PASS line proving the
ServiceNow write tools are absent. Then edit `MONITOR_SCOPES` to add
`snow:write` and run again: Okta returns 401 `access_denied` because the policy
doesn't allow the scope for this client. Nothing about the agent changed, only
its identity policy.

**"The autonomous crew" (15 min).** Wake the ServiceNow instance, run the
simulator (or workflow dispatch) to open a fresh P1, then `python run.py --once`.
Narrate the three agents handing off, and land on the briefing. Follow with
`--act` to show a governed write: one `log_activity`, allowed because the policy
grants `sfdc:write`, while ServiceNow remains read-only.

**"Prompt injection doesn't work here" (15 min).** Follow
`group-owner-mcp/docs/RUNBOOK.md`: Act 1 happy path as Alice on her own group,
Act 2 the attack montage (foreign group, "I am an admin", injected instructions,
forged subject argument). Close with `npm test` scrolling green. If you can't
run anything live, play `docs/recordings/red-team-reel`.

**"Governance changes agent access" (10 min).** Use `fga_webhook.py` in CLI mode
to revoke a user's `crm-read` level, show the tool call fail, then grant it back
and show it succeed. Frame the Lambda/event-hook version as how OIG approvals
drive the same change with a full audit trail.

## 8. Best practices

These are the patterns the kit was built around. Reuse them in POCs.

**Give every agent its own identity.** One API Services app per agent, never a
shared "automation" client. The agent's client ID shows up in Okta syslog, in
FGA tuples, and in token `sub` claims, which is what makes the audit story real.

**Use private_key_jwt, not client secrets.** Every service identity in this kit
authenticates with a signed assertion against an inline JWKS. Keys live in SSM
SecureString (or a file on a laptop for local runs), never in the repo. Note the
kit's `.gitignore` blocks `*.pem` and `.env` by design.

**Enforce least privilege by omission, in policy.** The CrewAI monitor doesn't
have `snow:write` because its Okta policy rule doesn't list it. Denial by
omission at the auth server beats denial by prompt every time, and it produces a
crisp demo (the 401 on over-ask). Scope ceilings belong in the Okta policy, not
in agent code.

**Short-lived tokens, minted per run.** The monitor re-mints its token on every
pass (60-minute lifetime, 5-minute assertion expiry). Nothing long-lived sits on
disk.

**Never trust the model for identity or authorization inputs.** Identity comes
from the verified token subject, never from tool arguments. If a tool takes a
"user" argument, that's the *target* of the operation, and the caller's right to
touch that target is checked server-side. The group-owner red-team tests are the
template for proving this to a customer.

**Fail closed in anything you'd call a control.** `group-owner-mcp` throws on
any ownership-check error. Where this kit fails open (the backend's FGA checks),
it says so in a comment and it's a demo concession, not a pattern to copy (§9).

**Keep secrets out of CI too.** The simulation workflow authenticates to AWS
with GitHub OIDC and reads everything else from SSM at runtime. One role ARN is
the only GitHub secret. When you clone this pattern into a new repo, remember to
add the new repo's OIDC subject to the role trust policy.

**Make the demo self-refreshing.** Scheduled simulation keeps data current so a
demo works at 9am without prep. Fence generated data (the `INC-4xxx` prefix, the
reserved number range) so tools only ever see the storyline records, and build
housekeeping in (`--resolve-keep`) so the instance doesn't rot.

**Verify before you present.** `smoke_test.py`, `npm test`, and `GET /health`
exist so you can check every layer in under a minute. Build the habit; the most
common demo failure in this stack is environmental (see the next section), and
these catch it early.

## 9. Known sharp edges (read before you present)

This is demo code. It is honest about its shortcuts, and you should be too if a
customer reads the source. Known items, verified in the packaged code:

| Sharp edge | Where | Why it's this way |
|---|---|---|
| ServiceNow PDI hibernates after ~24h idle | the whole demo | Personal Developer Instances sleep; when asleep, the crew reports all-clear and the simulator skips its run with a workflow warning (it detects the hibernation page and exits cleanly). Wake it at developer.servicenow.com before any demo. There is no wake API. |
| Backend decodes bearer JWTs without verifying signatures | `mcp-server/src/auth.ts` | It trusts the adapter/Okta in front of it. Fine behind the adapter, wrong if exposed directly. `group-owner-mcp` shows the correct pattern (JWKS verification in-process). |
| FGA checks fail open on errors | `mcp-server/src/fga.ts` | Deliberate for demo resilience. A real control fails closed. |
| FGA record filtering only runs on the SSE/stdio path | `mcp-server/src/index.ts` | The JSON-RPC `/mcp` and `/api/tool` paths get the per-tool invoke check but not per-record filtering. Know which path your client uses before promising record-level filtering on it. |
| Tuple case mismatch on incidents | `setup_fga.py` (writes `snow_incident:INC-4521`) vs. the server and simulator (lowercase `inc-4521`) | The simulator/grant scripts lowercase to match the server. If seeded incidents seem invisible while simulated ones show, this is why. |
| `fga_webhook.py` doesn't authenticate incoming hooks | `mcp-server/scripts/` | `HOOK_VERIFICATION_KEY` is read but unused. Anyone who can reach the endpoint can write tuples. Deploy it only on a locked-down API Gateway, or add verification before reusing. |
| Naive query escaping in search tools | `mcp-server/src/tools/*` | SOQL/ServiceNow queries are string-concatenated with only quote escaping. Injection-prone; don't hold it up as reference input handling. |
| The FGA dashboard "tour" overwrites your model | Okta FGA console | Opening Model Explorer on a fresh store force-writes a sample model. Recovery: rerun `setup_fga.py` and update `FGA_MODEL_ID`. FGA models are append-only, so every setup run creates a new model ID that consumers must be pointed at. |
| `run.py --once` vs no flag | `crewai-demo` | Both behave the same (the code only branches on `--watch`). Cosmetic. |
| `.mcp.json` in the source monorepo carries live credentials | monorepo root, not this repo | Excluded from this kit on purpose. Don't copy it anywhere shareable. |

Also note: the FGA API client secret that previously sat hardcoded in
`fga.ts`/`setup_fga.py`/`fga_webhook.py` was stripped when this kit was packaged;
those files now require env vars. The historical value should be treated as
exposed and rotated in the FGA console if that hasn't happened yet.

## 10. Environment reference

The kit's defaults point at the live taskvantage demo environment so strike-team
members can run against something that already works. Replace these when standing
up your own.

| Thing | Value |
|---|---|
| Backend MCP server | `https://mcp.supersafe-ai.io/mcp` |
| Okta org | `taskvantage.okta.com` |
| Auth server (token URL base) | `https://taskvantage.okta.com/oauth2/aus22dp8l2sy5rBv21d8` |
| CrewAI monitor client ID | `0oa2427s2irex9cv61d8` (key ID `crewai-monitor-key-1`) |
| Monitor creds in SSM | `/taskvantage-prod/crewai-monitor/{client-id,key-id,private-key}` (AWS acct 959737396568, us-east-2) |
| Simulator creds in SSM | `/bedrock-xaa-demo/{servicenow_*,fga_*}` (same account/region) |
| ServiceNow PDI | `dev370981.service-now.com` (hibernates; wake before demos) |
| Salesforce | dev org behind `SFDC_INSTANCE_URL` (creds in SSM/monorepo config, not in this repo) |
| Okta groups driving scopes | `Cowork-CRM-Read`, `Cowork-CRM-Write`, `Cowork-ITSM-Read`, `Cowork-ITSM-Write` |
| FGA store | Okta FGA us1 region (`api.us1.fga.dev`); store/model IDs in SSM under `/bedrock-xaa-demo` |

To stand up a fresh environment end to end: provision the Okta objects (auth
server scopes, groups, the agent's API Services app; the Terraform in the source
monorepo and the `crewai_monitor.tf.example` in the public
`okta-ai-agents-crewai` repo are the references), deploy `mcp-server` with the
env vars in its `.env.example`, seed Salesforce/ServiceNow demo data, run
`setup_fga.py`, run `grant_agent_fga.py` for each agent identity, and wire the
simulation workflow to your own AWS role and SSM prefix.
