# MCP Server Scripts

## setup_fga.py — Okta FGA Authorization Model Setup

Creates the fine-grained authorization model and tuples in Okta FGA for the MCP server demo.

### Usage

```bash
python3 scripts/setup_fga.py
```

### What it does

1. **Writes the authorization model** (5 types: user, team, tool, sfdc_account, snow_incident)
2. **Writes 67 tuples** (teams, tool permissions, account ownership, incident access)
3. **Runs 7 verification checks** to confirm the model is working

### Re-running

The script is idempotent:
- Creates a new model version each run (FGA models are append-only)
- Tuples that already exist are skipped gracefully
- Always runs verification checks at the end

**You should re-run this script** after any FGA store reset or if the tour mode overwrites the model (see warning below).

### Known Issue: FGA Dashboard Tour Mode

> **WARNING:** When you open the FGA Dashboard Model Explorer for a **new store** for the first time, FGA presents a mandatory interactive tour that creates a sample `doc/folder` authorization model. **This overwrites the active model** for the store.
>
> **Impact:** The MCP server uses an explicit `FGA_MODEL_ID` in its configuration, so existing checks continue to work against the old model version. However, the FGA Dashboard UI will show the tour model as "latest", which can be confusing.
>
> **Recovery:** Re-run `python3 scripts/setup_fga.py` to create a new model version with our types. Update `FGA_MODEL_ID` in `src/fga.ts` with the new model ID printed by the script, then redeploy the MCP server.
>
> **Prevention:** There is no way to skip the tour. If you need to open the Model Explorer on a fresh store, re-run the setup script immediately afterward.

### Environment Variables

The script reads its credentials from the environment and refuses to run without them:

| Variable | Value |
|----------|---------------|
| `FGA_API_URL` | `https://api.us1.fga.dev` (default; use your FGA region) |
| `FGA_STORE_ID` | Your FGA store ID |
| `FGA_CLIENT_ID` | Your FGA API client ID |
| `FGA_CLIENT_SECRET` | Your FGA API client secret |

### Authorization Model Summary

| Type | Relations | Purpose |
|------|-----------|---------|
| `user` | — | Identity anchor |
| `team` | `member` | Territory / role grouping |
| `tool` | `can_invoke`, `can_invoke_read`, `can_invoke_write` | Per-tool invocation control |
| `sfdc_account` | `owner`, `viewer`, `editor` | Salesforce account-level access |
| `snow_incident` | `assignee`, `viewer`, `editor` | ServiceNow incident-level access |
