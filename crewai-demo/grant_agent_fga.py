# ABOUTME: One-time FGA onboarding for the headless monitor agent.
# ABOUTME: Grants the agent's FGA user the standing access it needs to read data:
# ABOUTME: can_invoke_read on the read tools, viewer on the demo accounts, and
# ABOUTME: viewer on the current incidents. New incidents are granted on the fly
# ABOUTME: by simulate_activity.py; this covers tools, accounts, and the backlog.
"""
Run once (idempotent) after creating the monitor's Okta identity, so its
client_credentials token can actually read through the FGA-gated MCP tools.

  python3 grant_agent_fga.py --use-ssm                 # read access (default)
  python3 grant_agent_fga.py --use-ssm --write         # also allow --act writes

Okta scopes gate *which tools are visible*; Okta FGA gates *whether a call /
record is allowed*. This script writes the FGA tuples for the agent.
"""
import argparse

from simulate_activity import (
    FGAClient, ServiceNowClient, load_credentials, DEFAULT_AGENT_USER,
)

READ_TOOLS = [
    "search_accounts", "get_account_details", "search_opportunities", "list_contacts",
    "search_incidents", "get_incident", "list_my_incidents", "search_enhancements",
]
WRITE_TOOLS = ["create_opportunity", "update_opportunity", "log_activity"]
ACCOUNT_SLUGS = [
    "acme-corp", "pinnacle-financial", "northstar-insurance",
    "meridian-healthcare", "apex-manufacturing",
]


def main():
    ap = argparse.ArgumentParser(description="Grant the monitor agent FGA access (Layer 2).")
    ap.add_argument("--agent-user", default=DEFAULT_AGENT_USER,
                    help="FGA user to grant (default: the monitor agent's client_id).")
    ap.add_argument("--write", action="store_true",
                    help="Also grant write tools + account editor (needed for the --act demo).")
    ap.add_argument("--no-backfill", action="store_true",
                    help="Skip granting viewer on the current INC-4* incidents.")
    # Credentials (same surface as simulate_activity.py)
    ap.add_argument("--use-ssm", action="store_true")
    ap.add_argument("--ssm-prefix", default="/bedrock-xaa-demo")
    ap.add_argument("--aws-profile")
    ap.add_argument("--aws-region", default="us-east-2")
    ap.add_argument("--snow-instance-url")
    ap.add_argument("--snow-user")
    ap.add_argument("--snow-password")
    args = ap.parse_args()

    snow_creds, fga_creds = load_credentials(args)
    if not all(fga_creds.get(k) for k in ("store_id", "model_id", "client_id", "client_secret")):
        raise SystemExit("Missing FGA credentials. Provide FGA_* env or --use-ssm.")
    fga = FGAClient(fga_creds["api_url"], fga_creds["store_id"], fga_creds["model_id"],
                    fga_creds["client_id"], fga_creds["client_secret"])

    user = f"user:{args.agent_user}"
    n = 0
    for t in READ_TOOLS:
        fga.grant(user, "can_invoke_read", f"tool:{t}"); n += 1
    for a in ACCOUNT_SLUGS:
        fga.grant(user, "viewer", f"sfdc_account:{a}"); n += 1
    if args.write:
        for t in WRITE_TOOLS:
            fga.grant(user, "can_invoke_write", f"tool:{t}"); n += 1
        for a in ACCOUNT_SLUGS:
            fga.grant(user, "editor", f"sfdc_account:{a}"); n += 1
    if not args.no_backfill:
        snow = ServiceNowClient(snow_creds["instance_url"], snow_creds["username"], snow_creds["password"])
        rows = snow.query_table("incident", query="numberSTARTSWITHINC-4", fields=["number"], limit=500)
        for r in rows:
            num = r.get("number", "")
            if num.startswith("INC-4"):
                fga.grant(user, "viewer", f"snow_incident:{num.lower()}"); n += 1

    print(f"Granted {n} FGA tuple(s) to {user} "
          f"({'read+write' if args.write else 'read-only'}"
          f"{'' if args.no_backfill else ', incidents backfilled'}).")


if __name__ == "__main__":
    main()
