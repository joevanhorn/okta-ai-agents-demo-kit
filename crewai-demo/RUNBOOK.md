# CrewAI Account Risk Monitor — Operator Runbook

Step-by-step instructions for getting the demo running. Copy-paste-able commands throughout.

**Overview**: See [README.md](README.md)
**Architecture & findings**: See [docs/SECURING-CREWAI-WITH-OKTA.md](../../../docs/SECURING-CREWAI-WITH-OKTA.md)
**Auth path test results**: See [docs/MCP-ADAPTER-AUTH-PATH-TESTS.md](../../../docs/MCP-ADAPTER-AUTH-PATH-TESTS.md)

---

## Prerequisites

- Python 3.10+
- AWS CLI configured with access to the `taskvantage` account (`959737396568`, `us-east-2`) — or the Okta credentials retrieved another way (see Step 3)
- Network access to `mcp.supersafe-ai.io` and `taskvantage.okta.com`
- A LiteLLM gateway key **or** a direct provider API key (see Step 4)

---

## Step 1 — Create the virtual environment and install dependencies

Run from the `crewai-demo/` directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Step 2 — Create your `.env` file

```bash
cp .env.example .env
```

Do **not** commit `.env` — it is gitignored. Fill it in using Steps 3 and 4 below.

---

## Step 3 — Configure Okta credentials

The crew's Okta service account identity was provisioned by Terraform. Three options are supported; **SSM is recommended** for this demo host.

### Option 1 — AWS SSM (recommended)

The private key lives in SSM in the `taskvantage` account. Set `AWS_PROFILE=taskvantage` and `OKTA_CLIENT_ID` / `OKTA_KEY_ID` in `.env`; `okta_auth.py` pulls the private key from SSM automatically.

```bash
# Fetch the values (run once to copy into .env)
aws --profile taskvantage ssm get-parameter \
  --region us-east-2 \
  --name /taskvantage-prod/crewai-monitor/client-id \
  --query Parameter.Value --output text

aws --profile taskvantage ssm get-parameter \
  --region us-east-2 \
  --name /taskvantage-prod/crewai-monitor/key-id \
  --query Parameter.Value --output text

# The private key is a SecureString — always use --with-decryption
aws --profile taskvantage ssm get-parameter \
  --region us-east-2 \
  --name /taskvantage-prod/crewai-monitor/private-key \
  --with-decryption \
  --query Parameter.Value --output text
```

In `.env` set:

```dotenv
OKTA_CLIENT_ID=0oa2427s2irex9cv61d8
OKTA_KEY_ID=crewai-monitor-key-1
AWS_PROFILE=taskvantage
# Leave OKTA_PRIVATE_KEY_PEM and OKTA_PRIVATE_KEY_FILE unset —
# okta_auth.py will pull the key from SSM automatically.
```

### Option 2 — Terraform outputs

```bash
cd environments/taskvantage-prod/terraform
terraform output -raw crewai_monitor_client_id
terraform output -raw crewai_monitor_private_key_pem   # preserves newlines
```

Paste the values into `.env`:

```dotenv
OKTA_CLIENT_ID=<output from terraform>
OKTA_KEY_ID=crewai-monitor-key-1
OKTA_PRIVATE_KEY_PEM=<paste PEM including header/footer lines>
```

### Option 3 — Key file on disk

If you saved the PEM to a file:

```dotenv
OKTA_CLIENT_ID=0oa2427s2irex9cv61d8
OKTA_KEY_ID=crewai-monitor-key-1
OKTA_PRIVATE_KEY_FILE=/path/to/crewai-monitor-private-key.pem
```

`OKTA_PRIVATE_KEY_FILE` takes highest priority; SSM is the fallback when neither PEM variable is set.

---

## Step 4 — Configure the LLM

### Option A — LiteLLM proxy/gateway (PRIMARY path for this operator)

This is the recommended path. CrewAI uses LiteLLM under the hood, so setting `LITELLM_API_BASE` and `LITELLM_API_KEY` routes every LLM call through your gateway without changing any code.

In `.env`:

```dotenv
LITELLM_API_BASE=https://your-litellm-proxy.example.com
LITELLM_API_KEY=sk-your-litellm-virtual-key
MONITOR_LLM=openai/claude-haiku-4-5-20251001
# LiteLLM proxies are OpenAI-compatible. Use the openai/ prefix for models
# routed via an OpenAI-compatible endpoint on your proxy. Adjust the model
# name to match what your proxy exposes (e.g. openai/gpt-4o-mini,
# openai/claude-3-5-haiku, etc.).
```

### Option B — Direct provider key (fallback)

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
MONITOR_LLM=anthropic/claude-haiku-4-5-20251001
# Leave LITELLM_API_BASE and LITELLM_API_KEY unset.
```

---

## Complete example `.env` (LiteLLM path)

Copy this block into `.env` and replace the placeholder values:

```dotenv
# ── Okta identity (SSM path — recommended) ───────────────────────────────
OKTA_CLIENT_ID=0oa2427s2irex9cv61d8
OKTA_KEY_ID=crewai-monitor-key-1
AWS_PROFILE=taskvantage
# OKTA_PRIVATE_KEY_FILE=   # uncomment to load key from disk instead of SSM
# OKTA_PRIVATE_KEY_PEM=    # uncomment to paste inline PEM instead of SSM

# ── Okta token endpoint ───────────────────────────────────────────────────
OKTA_TOKEN_URL=https://taskvantage.okta.com/oauth2/aus22dp8l2sy5rBv21d8/v1/token

# ── MCP backend ───────────────────────────────────────────────────────────
MCP_BACKEND_URL=https://mcp.supersafe-ai.io/mcp

# ── Scopes — DO NOT add snow:write; Okta policy will reject it ────────────
MONITOR_SCOPES=sfdc:read sfdc:write snow:read

# ── LLM — LiteLLM proxy (PRIMARY) ────────────────────────────────────────
LITELLM_API_BASE=https://your-litellm-proxy.example.com
LITELLM_API_KEY=sk-your-litellm-virtual-key
MONITOR_LLM=openai/claude-haiku-4-5-20251001

# ── Watch mode interval (seconds, used by --watch) ───────────────────────
WATCH_INTERVAL=300
```

---

## Step 5 — Verify access without spending LLM tokens

Run the smoke test first. It mints a token, decodes granted scopes, connects to the MCP backend, enumerates tools, and asserts that `snow:write` tools are absent. **No LLM call is made.**

```bash
python smoke_test.py
```

### Expected output

```
======================================================================
CrewAI Account Risk Monitor - Smoke Test
======================================================================

[1] Loading configuration...
  OKTA_TOKEN_URL: https://taskvantage.okta.com/oauth2/aus22dp8l2sy5rBv21d8/v1/token
  OKTA_CLIENT_ID: 0oa2427s2irex9cv61d8
  MCP_BACKEND_URL: https://mcp.supersafe-ai.io/mcp
  Requested scopes: sfdc:read sfdc:write snow:read

[2] Minting access token via private_key_jwt...
  ✓ Token minted (NNN chars)

[3] Decoding token and verifying granted scopes...
  Granted scopes: ['sfdc:write', 'sfdc:read', 'snow:read']
  ✓ Decoded 3 scopes

[4] Connecting to MCP backend...
  ✓ Connected to MCP backend

[5] Enumerating MCP tools...
  Total tools: 11
    - create_activity
    - create_opportunity
    - get_account_details
    - get_incident
    - list_contacts
    - list_my_incidents
    - log_activity
    - search_accounts
    - search_incidents
    - search_opportunities
    - update_opportunity

[6] Verifying snow:write tool gating...
  ✓ PASS: snow:write tools absent (policy working)

======================================================================
✓ Smoke test PASSED
======================================================================
```

Key things to confirm:
- Granted scopes include `sfdc:write`, `sfdc:read`, `snow:read` — nothing more.
- Exactly 11 tools are visible.
- `create_incident`, `update_incident`, `add_work_note` are **not** in the list.

---

## Step 6 — Single monitoring pass (calls the LLM)

```bash
python run.py --once
```

Runs the full sequential crew (Incident Watcher → Account Correlator → Risk Reporter) and prints a risk briefing. Default is **report-only** — no writes occur.

---

## Step 7 — Allow the one write action

```bash
python run.py --once --act
```

Same as `--once` but authorises the Risk Reporter to call `log_activity` once on the highest-risk Salesforce account after generating the briefing. All other write tools remain off-limits regardless of this flag. `snow:write` tools are still absent — the policy ceiling is enforced at token mint, not at call time.

---

## Step 8 — Autonomous watch loop

```bash
python run.py --watch --interval 300
```

Loops indefinitely. On each pass: re-mints the Okta token, re-opens the MCP connection, and runs the full crew. Press `Ctrl+C` to stop cleanly. Interval is in seconds; default is `300` (also settable via `WATCH_INTERVAL` in `.env`).

---

## Scheduling

### Built-in watch loop

The simplest option:

```bash
python run.py --watch --interval 900
```

### Cron (quick deployment)

Replace `<abs-dir>` with the absolute path to the `crewai-demo/` directory:

```cron
*/15 * * * * cd <abs-dir> && .venv/bin/python run.py --once >> monitor.log 2>&1
```

Each cron invocation is fully independent. The token is minted fresh on every pass — `client_credentials` tokens have a 1-hour lifetime and there is no refresh token in this flow, so re-minting each pass is the correct pattern. Long-running scheduled jobs are fine.

---

## Quick troubleshooting

See [README.md](README.md) for the full troubleshooting table. Common issues:

| Symptom | Cause | Fix |
|---|---|---|
| `401 access_denied` at token mint | Requested a scope the policy does not grant (e.g. `snow:write`) | Set `MONITOR_SCOPES=sfdc:read sfdc:write snow:read` — do not add `snow:write`. |
| `401 invalid_client` at token mint | Wrong `client_id` or key mismatch | Check `OKTA_CLIENT_ID` and `OKTA_KEY_ID`; confirm the private key matches the JWK registered on the Okta app. |
| `Failed to load private key from SSM` | Wrong AWS profile | Set `AWS_PROFILE=taskvantage` in `.env` or export it. The key lives in account `959737396568`. |
| LLM/auth error at crew kickoff | `LITELLM_API_KEY` or `ANTHROPIC_API_KEY` not set, or proxy unreachable | Confirm the LLM env vars are set and the proxy URL is reachable from the demo host. |
| 0 tools visible | Token has no recognised tool scopes | Check `MONITOR_SCOPES` in `.env` and confirm the access policy on the Okta auth server grants those scopes to this client. |

---

## Verification checklist

Run through these before a demo:

- [ ] `python smoke_test.py` exits 0 with "Smoke test PASSED"
- [ ] Smoke test reports exactly 3 granted scopes: `sfdc:read`, `sfdc:write`, `snow:read`
- [ ] Smoke test reports 11 visible tools
- [ ] Smoke test confirms `snow:write` tools (`create_incident`, `update_incident`, `add_work_note`) are absent
- [ ] `python run.py --once` completes and prints a risk briefing
- [ ] Adding `snow:write` to `MONITOR_SCOPES` returns `401 access_denied` at token mint (demonstrable over-ask rejection — restore the correct scopes afterwards)
