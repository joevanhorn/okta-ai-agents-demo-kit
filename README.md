# Okta AI Agents Demo Kit

A packaged set of the custom-built demo components behind the "Okta for AI Agents"
story: two custom MCP servers, an autonomous CrewAI agent crew, and the activity
simulation workflow that keeps the demo data fresh.

**Audience:** Solutions Engineers on the strike team focused on Okta's AI offerings.

**Start here:** [`docs/SE-GUIDE.md`](docs/SE-GUIDE.md) covers the architecture,
every component in depth, demo playbooks, and best practices. This README is just
the map.

## What's in the box

| Directory | What it is |
|---|---|
| [`mcp-server/`](mcp-server/) | The SuperSafe-AI backend MCP server (TypeScript). 14 Salesforce + ServiceNow tools, gated by Okta OAuth scopes and Okta FGA. This is the resource server that agents call. |
| [`group-owner-mcp/`](group-owner-mcp/) | A standalone MCP server (TypeScript) that lets Okta group *owners* manage group *members* through an AI agent with no admin role. Ships with red-team tests, an offline mock mode, a demo runbook, and screen recordings. |
| [`crewai-demo/`](crewai-demo/) | The CrewAI "Account Risk Monitor": a headless three-agent crew that authenticates to Okta as itself (client_credentials + private_key_jwt) and calls `mcp-server` with a scoped bearer token. Includes `smoke_test.py`, the runbook, and sample output. |
| [`crewai-demo/simulate_activity.py`](crewai-demo/simulate_activity.py) + [`grant_agent_fga.py`](crewai-demo/grant_agent_fga.py) | The simulation tooling: opens fresh P1/P2 ServiceNow incidents on at-risk accounts and grants the monitor agent FGA access to them. |
| [`.github/workflows/simulate-activity.yml`](.github/workflows/simulate-activity.yml) | Scheduled GitHub workflow (every 6 hours + manual dispatch) that runs the simulator via AWS OIDC + SSM, so the crew always has something to find. |

## Five-minute orientation

The whole kit demonstrates one thesis: **agent restraint is an identity control,
not a prompt.** Each component shows a different layer of that control:

1. **Okta OAuth scopes decide which tools an agent can even see.** The CrewAI
   monitor's Okta policy grants `sfdc:read sfdc:write snow:read` and withholds
   `snow:write`, so the three ServiceNow write tools never appear in its
   `tools/list`. Over-asking returns a 401 from Okta.
2. **App-layer authorization decides what a visible tool will do.**
   `group-owner-mcp` checks live Okta group ownership before any member
   operation, and its red-team test suite proves prompt injection and forged
   arguments can't get around it.
3. **Okta FGA decides per-call and per-record access.** The backend checks
   `can_invoke_read`/`can_invoke_write` tuples per tool and filters result
   records by `viewer`/`owner` relationships.

## Quick starts

Each component keeps its own README with full setup. The shortest paths:

```bash
# Prove the scope boundary with zero cost (no LLM key needed)
cd crewai-demo && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && cp .env.example .env   # fill in .env
python smoke_test.py

# Run the group-owner demo fully offline (no Okta, no credentials)
cd group-owner-mcp && npm install
npm run mock          # terminal 1
npm test              # red-team suite, also offline

# Run the backend MCP server locally
cd mcp-server && npm install
cp .env.example .env  # fill in Salesforce/ServiceNow/FGA values
TRANSPORT=http npx tsx src/index.ts
```

## Secrets

No live credentials are committed to this repo. Everything reads from the
environment, `.env` files (gitignored), or AWS SSM Parameter Store. The
[SE guide](docs/SE-GUIDE.md#environment-reference) lists where the live demo
environment keeps its credentials.

## Related repos

- `joevanhorn/okta-ai-agents-crewai` (public): genericized, pip-installable
  version of the CrewAI monitor for sharing outside the team.
- `joevanhorn/okta-governance-mcp-demo` (private): the OIG certification-review
  MCP server and dashboard.
- `joevanhorn/okta-xaa-mcp-server` (private): the ServiceNow + Google Workspace
  MCP server with per-user cross-app access (ID-JAG) pass-through.
- `joevanhorn/ofcto-workforce-taskvantage` (private): the source monorepo these
  components were packaged from, including the Terraform that provisions the
  live demo environment.
