# Sample Output

---

## Verifying access (smoke test)

```
python smoke_test.py
```

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
  ✓ Token minted (836 chars)
[3] Decoding token and verifying granted scopes...
  Granted scopes: ['sfdc:write', 'sfdc:read', 'snow:read']
  ✓ Decoded 3 scopes
[4] Connecting to MCP backend...
  ✓ Connected to MCP backend
[5] Enumerating MCP tools...
  Total tools: 11
    - create_opportunity
    - get_account_details
    - get_incident
    - list_contacts
    - list_my_incidents
    - log_activity
    - search_accounts
    - search_enhancements
    - search_incidents
    - search_opportunities
    - update_opportunity
[6] Verifying snow:write tool gating...
  ✓ PASS: snow:write tools absent (policy working)
======================================================================
✓ Smoke test PASSED
======================================================================
```

**What this confirms:**

- Token minted successfully via `private_key_jwt` client_credentials
- Okta policy granted exactly the three requested scopes (`sfdc:read`, `sfdc:write`, `snow:read`)
- Backend MCP server reachable over streamable-http
- Tool list filtered to 11 tools — the three `snow:write` tools (`create_incident`, `update_incident`, `add_work_note`) are absent, Okta-enforced

---

## Single monitoring pass (`python run.py --once`)

```
python run.py --once
```

### Startup banner

```
======================================================================
  Account Risk Monitor — CrewAI / MCP Backend
======================================================================
  Mode          : ONCE / REPORT-ONLY
  Scopes        : sfdc:read sfdc:write snow:read
  Write enabled : NO — report only
  Backend URL   : https://mcp.supersafe-ai.io/mcp
  LLM           : anthropic/claude-haiku-4-5-20251001
  Watch interval: (not applicable in ONCE mode)

  Architecture  : Resource-Server model — token minted via Okta
                  private_key_jwt, passed as Bearer to MCP backend.
                  The backend scope-filters the tool list; ServiceNow
                  write tools are NOT visible with the default scopes.
======================================================================

[run] Starting single monitoring pass …
[monitor] Minting Okta token …
[monitor] Granted scopes: ['sfdc:write', 'sfdc:read', 'snow:read']
[monitor] Visible tools (11): ['create_opportunity', 'get_account_details', 'get_incident',
  'list_contacts', 'list_my_incidents', 'log_activity', 'search_accounts',
  'search_enhancements', 'search_incidents', 'search_opportunities', 'update_opportunity']
```

### Risk briefing output

> **Note:** The following briefing is **illustrative**. The LLM reasoning step that drives the three-agent crew requires a valid `ANTHROPIC_API_KEY`. The structure, ranking logic, and field names are accurate to the crew's task definitions; the account names, incident numbers, and dollar values are representative fictional data.

```
======================================================================
  RISK BRIEFING
======================================================================

Account Risk Briefing — 2026-06-11

RANKED AT-RISK ACCOUNTS
───────────────────────

#1  Meridian Financial Group
    Incident  : INC0042817 [P1] — Production API gateway returning 500 errors;
                payment processing impacted across all tenant regions
    Pipeline  : $2,400,000 (3 open opportunities — Enterprise Expansion Q3,
                Fraud Analytics Upsell, Multi-Region Contract Renewal)
    Action    : Escalate to on-call engineering lead immediately; CSM to call
                executive sponsor within 1 hour to get ahead of churn risk.

#2  Apex Retail Solutions
    Incident  : INC0042791 [P2] — Inventory sync job failing since 06:14 UTC;
                warehouse fulfilment data stale by 6+ hours
    Pipeline  : $875,000 (2 open opportunities — Q3 Platform Renewal,
                WMS Integration Add-On)
    Action    : Assign senior support engineer to INC0042791; account team to
                send proactive status update to VP Operations within 2 hours.

#3  Coastline Logistics Corp
    Incident  : INC0042803 [P2] — EDI message broker latency spike; partner
                integrations degraded, SLA breach threshold approaching
    Pipeline  : $340,000 (1 open opportunity — Annual Renewal FY26)
    Action    : Monitor SLA timer on INC0042803; if breach threshold crossed
                within 4 hours, trigger SLA credit process proactively to
                protect renewal.

───────────────────────
Accounts reviewed  : 3
Total pipeline at risk : $3,615,000
Mode               : REPORT-ONLY (no records modified)
======================================================================
```
