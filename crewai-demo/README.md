# CrewAI Account Risk Monitor

An open-source, headless multi-agent crew that runs on a schedule, finds open P1/P2 ServiceNow incidents, correlates them to at-risk Salesforce accounts and pipeline, and emits a ranked risk briefing. Built with [CrewAI](https://docs.crewai.com) and the SuperSafe-AI MCP backend.

This demo illustrates the **Resource Server** connection model for AI agents under Okta: the crew authenticates as itself (Okta `client_credentials` + `private_key_jwt`), receives a scoped bearer token, and calls the backend MCP server directly — with no human in the loop and no browser-based OAuth flow.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Okta Custom Authorization Server                    │
│  (aus22dp8l2sy5rBv21d8)                              │
│                                                      │
│  client_credentials + private_key_jwt                │
│  Scopes granted: sfdc:read sfdc:write snow:read      │
│  Scope ceiling enforced by policy → NOT snow:write   │
└───────────────────┬─────────────────────────────────┘
                    │ scoped access token
                    ▼
┌─────────────────────────────────────────────────────┐
│  CrewAI Account Risk Monitor (this repo)             │
│                                                      │
│  Sequential crew:                                    │
│    1. Incident Watcher  (snow:read)                  │
│    2. Account Correlator (sfdc:read)                 │
│    3. Risk Reporter      (sfdc:write / report-only)  │
└───────────────────┬─────────────────────────────────┘
                    │ Authorization: Bearer <token>
                    ▼
┌─────────────────────────────────────────────────────┐
│  Backend MCP Server                                  │
│  https://mcp.supersafe-ai.io/mcp                     │
│  (JSON-RPC over streamable-http)                     │
│                                                      │
│  tools/list filtered by token scopes → 11 tools     │
│  snow:write tools never appear in toolset            │
└─────────────────────────────────────────────────────┘

  ✗ MCP Adapter (adapter.supersafe-ai.io) is BYPASSED
    — it only serves sessions it brokered itself and
      returns 401 on pre-acquired tokens (tests T3/T4
      in docs/MCP-ADAPTER-AUTH-PATH-TESTS.md)
```

---

## Connection model: Resource Server, not MCP Server

Okta supports two ways a CrewAI agent can reach MCP tools:

| Model | How it works | When to use |
|---|---|---|
| **MCP Server connection** | Brokered OAuth through the Okta MCP adapter; the adapter handles the full OIDC/OAuth flow and issues a session | Interactive clients (Claude.ai, CrewAI AMP) where a human or host can participate in the browser-based OAuth flow |
| **Resource Server connection** | The agent mints its own scoped access token via `client_credentials` and passes it as a `Bearer` header directly to the backend MCP server | Headless, scheduled agents — no human, no browser, no adapter |

This demo uses the **Resource Server** model. The Okta MCP adapter (`adapter.supersafe-ai.io`) is deliberately bypassed: it only serves OAuth sessions it brokered itself and rejects any pre-acquired token with a 401. Verified behavior is documented in `docs/MCP-ADAPTER-AUTH-PATH-TESTS.md` (tests T3 and T4).

Open-source CrewAI can pass a static `Authorization: Bearer` header to an MCP server but cannot execute a full browser-based OAuth flow. The Resource Server model is the correct architecture for this use case.

---

## Prerequisites

- Python 3.11+
- Access to the `taskvantage` AWS account (`959737396568`) or the Okta client credentials via Terraform outputs / SSM (see [Setup](#setup))
- An `ANTHROPIC_API_KEY` for the LLM reasoning step (not needed for the smoke test)
- Network access to `mcp.supersafe-ai.io` and `taskvantage.okta.com`

---

## Setup

### 1. Create the virtual environment and install dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in the values (see the next section for where to get them).

### 3. Credentials

The crew's Okta identity is provisioned by Terraform (`environments/taskvantage-prod/terraform/crewai_monitor.tf`). The credentials are stored in two places:

**Option A — AWS SSM (recommended for the demo host)**

The Terraform apply writes three SSM parameters to the `taskvantage` account (`959737396568`, `us-east-2`):

| Parameter | Description |
|---|---|
| `/taskvantage-prod/crewai-monitor/client-id` | The Okta client ID (`OKTA_CLIENT_ID`) |
| `/taskvantage-prod/crewai-monitor/key-id` | The key ID (`OKTA_KEY_ID`), value `crewai-monitor-key-1` |
| `/taskvantage-prod/crewai-monitor/private-key` | RSA private key PEM (SecureString) |

Set `AWS_PROFILE=taskvantage` (or export it) and leave `OKTA_PRIVATE_KEY_PEM` and `OKTA_PRIVATE_KEY_FILE` unset. `okta_auth.py` will fall through to SSM automatically.

```bash
# Fetch values interactively
export AWS_PROFILE=taskvantage
aws ssm get-parameter --name /taskvantage-prod/crewai-monitor/client-id --query Parameter.Value --output text
aws ssm get-parameter --name /taskvantage-prod/crewai-monitor/key-id --query Parameter.Value --output text
aws ssm get-parameter --name /taskvantage-prod/crewai-monitor/private-key --with-decryption --query Parameter.Value --output text
```

**Option B — Terraform outputs**

```bash
cd environments/taskvantage-prod/terraform
terraform output crewai_monitor_client_id
terraform output crewai_monitor_key_id
terraform output -raw crewai_monitor_private_key_pem  # raw to preserve newlines
```

Paste these into your `.env` as `OKTA_CLIENT_ID`, `OKTA_KEY_ID`, and `OKTA_PRIVATE_KEY_PEM`.

**Option C — Key file on disk**

Set `OKTA_PRIVATE_KEY_FILE=/path/to/private-key.pem` in `.env`. This takes highest priority over the other options.

### 4. Private key loading priority

`okta_auth.py` loads the private key in this order:

1. `OKTA_PRIVATE_KEY_FILE` (path to a PEM file on disk)
2. `OKTA_PRIVATE_KEY_PEM` (inline PEM string in the environment)
3. SSM Parameter Store (`/taskvantage-prod/crewai-monitor/private-key`) — requires AWS credentials with the `taskvantage` profile

### 5. Set your Anthropic API key

```bash
# In .env:
ANTHROPIC_API_KEY=sk-ant-...
```

Not needed for `smoke_test.py`. Required for all `run.py` invocations.

---

## Running

### Smoke test (no LLM required)

Verifies that the token mints correctly, granted scopes match the policy, the backend MCP server is reachable, and the `snow:write` tools are absent from the toolset.

```bash
python smoke_test.py
```

Expected: 11 tools enumerated, `create_incident` / `update_incident` / `add_work_note` absent, exit 0.

### Single monitoring pass

```bash
python run.py --once
```

Runs the full sequential crew (Incident Watcher → Account Correlator → Risk Reporter) and prints a risk briefing. Report-only by default.

### Continuous watch loop

```bash
python run.py --watch --interval 300
```

Loops indefinitely. Re-mints the Okta token and re-opens the MCP connection on every pass. Press `Ctrl+C` to stop cleanly. The default interval is 300 seconds (also settable via `WATCH_INTERVAL` in `.env`).

### Enable the write action

```bash
python run.py --once --act
```

Authorises the Risk Reporter to call `log_activity` once on the highest-risk Salesforce account after generating the briefing. All other write tools remain off-limits regardless of this flag.

---

## Scheduling

### Built-in watch loop

The simplest option for a demo or development environment:

```bash
python run.py --watch --interval 900
```

### Cron (quick deployment)

```cron
*/15 * * * * cd /path/to/crewai-demo && .venv/bin/python run.py --once >> monitor.log 2>&1
```

Each cron invocation is independent; the token is minted fresh on every pass (client_credentials tokens have a 1-hour lifetime; there is no refresh token in this flow, so the token is simply re-minted each time).

### Production options

For production, prefer a **systemd timer** (on a VM/bare-metal host) or an **ECS scheduled task** (on AWS) over a raw cron job — both provide restart-on-failure semantics, structured logging, and IAM-scoped execution roles.

---

## How least privilege works here

The crew's Okta identity carries exactly three scopes: `sfdc:read`, `sfdc:write`, `snow:read`. The scope ceiling is enforced by a dedicated client-credentials policy on the MCP Adapter custom authorization server (`aus22dp8l2sy5rBv21d8`).

**What this means in practice:**

1. **Tool visibility is scope-filtered.** The backend MCP server (`mcp.supersafe-ai.io`) inspects the token scopes and returns only the tools the token is authorised for. With the three granted scopes the toolset contains **11 tools**. The three ServiceNow-write tools (`create_incident`, `update_incident`, `add_work_note`) that require `snow:write` are **never present** — they do not appear in `tools/list` at all, so the crew cannot even attempt to call them.

2. **Over-asking is rejected at token mint.** If the code were modified to request `snow:write`, Okta would return `401 access_denied` immediately — before any MCP call is made. The policy is the ceiling; the code cannot override it. This is verified behaviour: see `docs/MCP-ADAPTER-AUTH-PATH-TESTS.md`.

3. **The `--act` flag controls a single authorised write.** With `snow:write` absent, the only write available to the crew is `log_activity` (Salesforce activity log), which is gated by `sfdc:write`. Even this write is opt-in via `--act`; by default the crew is fully read-only.

The smoke test asserts this boundary on every run (`[6] Verifying snow:write tool gating`).

---

## Security notes

- **Standing privilege.** A `client_credentials` agent holds long-lived identity credentials (the RSA private key). Unlike a user session, there is no MFA, no step-up, and no revocation via logout. Treat the private key as a high-value secret and rotate it if compromised.
- **Network restriction.** The backend MCP server trusts the token's scope claims; it does not have an additional layer of per-caller network allowlisting out of the box. Keep the agent host on a restricted network or VPC where possible.
- **Keep scopes minimal.** The current policy deliberately excludes `snow:write`. Do not add scopes without reviewing what additional tools they unlock.
- **Key storage.** The private key is stored as an SSM `SecureString` in the `taskvantage` account. Access requires the `ClaudeCode-CrossAccount-CLI` role or equivalent IAM permissions. Do not check the PEM into source control — `.env` is gitignored.

Both standing-privilege and network-restriction caveats are discussed in `docs/MCP-ADAPTER-AUTH-PATH-TESTS.md`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 access_denied` at token mint | Requested a scope the policy does not grant (e.g. `snow:write`) | Request only the granted scopes (`sfdc:read sfdc:write snow:read`). The Okta policy is the ceiling — the code cannot override it. |
| `401 invalid_client` at token mint | Wrong `client_id` or key, or key does not match the one registered in Okta | Check `OKTA_CLIENT_ID` and `OKTA_KEY_ID` in `.env`; verify the SSM private key matches the JWK registered on the Okta app. |
| `MCPServerAdapter` lists 0 tools | Token has no recognised tool scopes | Check `MONITOR_SCOPES` in `.env` and confirm the access policy on the Okta auth server grants those scopes to this client. |
| `401 invalid_token` when pointing at the adapter (`adapter.supersafe-ai.io`) | The adapter rejects pre-acquired tokens — it only serves sessions it brokered itself | Target the backend directly: `MCP_BACKEND_URL=https://mcp.supersafe-ai.io/mcp`. See `docs/MCP-ADAPTER-AUTH-PATH-TESTS.md` (tests T3/T4). |
| Crew fails with an LLM / authentication error | `ANTHROPIC_API_KEY` not set | Add `ANTHROPIC_API_KEY=sk-ant-...` to `.env`. |
| Tool calls fail mid-run on a long `--watch` pass | Token expired (1-hour lifetime); a single very long reasoning step can outlast it | `--watch` mode re-mints on each pass, so this only affects a pass that takes longer than 1 hour. Shorten `--interval` or reduce crew verbosity to keep passes short. |
| `Failed to load private key from SSM` | AWS credentials not configured for the `taskvantage` account | Set `export AWS_PROFILE=taskvantage`. The key lives in account `959737396568`. |

---

## References

- **Operator runbook:** [`RUNBOOK.md`](./RUNBOOK.md) — step-by-step run guide (incl. the LiteLLM key path)
- **Findings / POC guidance:** [`docs/SECURING-CREWAI-WITH-OKTA.md`](../../../docs/SECURING-CREWAI-WITH-OKTA.md) — the two connection models and how to build a "secure CrewAI with Okta" POC guide
- [CrewAI MCP documentation](https://docs.crewai.com/en/mcp/overview)
- Auth-path test results: [`docs/MCP-ADAPTER-AUTH-PATH-TESTS.md`](../../../docs/MCP-ADAPTER-AUTH-PATH-TESTS.md) — why the backend accepts a scoped token directly (T3) while the adapter rejects pre-acquired tokens (T4); headless uses a client-credentials API Services app (T1/T2)
- Terraform identity: `environments/taskvantage-prod/terraform/crewai_monitor.tf`
