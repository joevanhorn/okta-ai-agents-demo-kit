# ABOUTME: Generates fresh, monitor-discoverable ServiceNow activity for the demo.
# ABOUTME: Spins off bedrock-agent/scripts/seed_demo_data.py: writes incidents straight
# ABOUTME: to the dev ServiceNow with explicit INC-4xxx numbers (the only ones the MCP
# ABOUTME: read tools return), tied to seeded Salesforce accounts so the Account Risk
# ABOUTME: Monitor correlates them to open pipeline and flags them.
"""
Simulate real-world activity the CrewAI Account Risk Monitor would flag.

Each run opens one (or more) high-priority ServiceNow incident on an at-risk
customer account, with a unique INC-46xx+ number so it's both discoverable by
the monitor's search_incidents/list_my_incidents tools and distinct from the
fixed seed set (INC-4498..4521). Optionally resolves older simulated incidents
so the open set stays bounded.

Credentials (ServiceNow basic auth) come from SSM (--use-ssm, prefix
/bedrock-xaa-demo) or explicit flags/env. No MCP token needed — this writes to
the backing system directly, exactly like seed_demo_data.py.

Usage:
  python3 simulate_activity.py --use-ssm                  # one incident, live
  python3 simulate_activity.py --use-ssm --mode dry-run   # show, don't write
  python3 simulate_activity.py --use-ssm --count 2 --resolve-keep 4
"""
import argparse
import os
import random
import sys
from datetime import datetime, timezone

import requests

# Seeded Salesforce account names that already have OPEN opportunities, so an
# incident on any of them correlates to real pipeline. Weighted toward the
# worst-health / highest-exposure accounts. Keep these in sync with
# bedrock-agent/config/demo_data_seed.yaml.
ACCOUNTS = [
    ("NorthStar Insurance", 3),   # Red health, $890K renewal at risk
    ("Acme Corp", 3),             # Yellow health, $360K expansion blocked
    ("Pinnacle Financial", 2),    # $1.2M POC in evaluation
    ("Meridian Healthcare", 1),   # $750K, healthy
    ("Apex Manufacturing", 1),    # $200K, healthy
]

# Realistic incident templates; {company} is filled in per run.
INCIDENT_TEMPLATES = [
    ("SSO authentication failures for {company} enterprise users",
     "Production SSO is intermittently failing for {company} users; login success "
     "rate is degraded and the account team has escalated."),
    ("MFA enrollment errors blocking {company} onboarding",
     "New {company} users cannot complete MFA enrollment, stalling onboarding "
     "ahead of go-live."),
    ("API rate-limit errors impacting {company} integration",
     "{company}'s production integration is hitting HTTP 429s, causing sync "
     "failures and data lag."),
    ("Provisioning sync failure for {company}",
     "Lifecycle provisioning to {company}'s downstream apps is failing; the "
     "deprovisioning backlog is growing."),
    ("Performance degradation reported by {company}",
     "{company} reports elevated latency on core flows during business hours; "
     "the SLA is at risk."),
]

# ServiceNow computes `priority` from impact x urgency — setting `priority`
# directly is ignored. These (impact, urgency) pairs yield priority 1/2/3 under
# the default calculation (verified: impact=1,urgency=1 -> priority 1).
IMPACT_URGENCY = {"P1": ("1", "1"), "P2": ("1", "2"), "P3": ("1", "3")}
# Numbers the simulator owns. The fixed seed uses INC-4498..4521; we stay clear.
SIM_NUMBER_MIN = 4600
SIM_NUMBER_MAX = 4999


# ---------------------------------------------------------------------------
# Minimal ServiceNow client (adapted from bedrock-agent/scripts/seed_demo_data.py)
# ---------------------------------------------------------------------------
class InstanceHibernatingError(Exception):
    """The PDI is asleep and serving its HTML hibernation page instead of JSON."""


def _check_awake(resp):
    # A hibernating PDI answers every API call with an HTML page (HTTP 200),
    # which previously surfaced as a JSONDecodeError deep in the run. Detect it
    # up front so callers can skip cleanly instead of crashing.
    ctype = resp.headers.get("Content-Type", "")
    if "text/html" in ctype or resp.text.lstrip()[:1] == "<":
        raise InstanceHibernatingError(
            "ServiceNow returned an HTML page instead of JSON (instance is "
            "hibernating). Wake it at developer.servicenow.com and retry."
        )


class ServiceNowClient:
    def __init__(self, instance_url, username, password):
        self.instance_url = instance_url.rstrip("/")
        self.auth = (username, password)
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}

    def query_table(self, table, query=None, fields=None, limit=50):
        params = {"sysparm_limit": limit}
        if query:
            params["sysparm_query"] = query
        if fields:
            params["sysparm_fields"] = ",".join(fields)
        resp = requests.get(
            f"{self.instance_url}/api/now/table/{table}",
            auth=self.auth, headers=self.headers, params=params, timeout=30,
        )
        _check_awake(resp)
        resp.raise_for_status()
        return resp.json().get("result", [])

    def create_record(self, table, data):
        resp = requests.post(
            f"{self.instance_url}/api/now/table/{table}",
            auth=self.auth, headers=self.headers, json=data, timeout=30,
        )
        _check_awake(resp)
        if resp.status_code in (200, 201):
            return resp.json()["result"]["sys_id"]
        raise Exception(f"Create {table} failed ({resp.status_code}): {resp.text}")

    def update_record(self, table, sys_id, data):
        resp = requests.patch(
            f"{self.instance_url}/api/now/table/{table}/{sys_id}",
            auth=self.auth, headers=self.headers, json=data, timeout=30,
        )
        _check_awake(resp)
        if resp.status_code != 200:
            raise Exception(f"Update {table}/{sys_id} failed ({resp.status_code}): {resp.text}")
        return True


# Default FGA user for the headless monitor agent: a client_credentials token's
# `sub` is the client_id, and that's the identifier the backend uses as the FGA
# user (see the backend's src/fga.ts -> `user:${userEmail}`).
DEFAULT_AGENT_USER = "0oa2427s2irex9cv61d8"


# ---------------------------------------------------------------------------
# Minimal Okta FGA (OpenFGA) write client — mirrors the backend's src/fga.ts.
# Grants the monitor agent `viewer` on each incident so the backend's per-record
# FGA check (Layer 2) returns it. Without this, the monitor's read tools are
# allowed (Layer 1) but the incident is filtered out.
# ---------------------------------------------------------------------------
class FGAClient:
    def __init__(self, api_url, store_id, model_id, client_id, client_secret):
        self.api_url = api_url.rstrip("/")
        self.store_id = store_id
        self.model_id = model_id
        tok = requests.post("https://auth.fga.dev/oauth/token", json={
            "client_id": client_id, "client_secret": client_secret,
            "audience": "https://api.us1.fga.dev/", "grant_type": "client_credentials",
        }, timeout=20)
        tok.raise_for_status()
        self._token = tok.json()["access_token"]

    def grant(self, user, relation, obj):
        """Write one tuple; treat 'already exists' as success."""
        r = requests.post(
            f"{self.api_url}/stores/{self.store_id}/write",
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
            json={"authorization_model_id": self.model_id,
                  "writes": {"tuple_keys": [{"user": user, "relation": relation, "object": obj}]}},
            timeout=20,
        )
        if r.status_code == 200 or "already exists" in r.text:
            return True
        raise Exception(f"FGA write failed ({r.status_code}): {r.text}")


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
def load_credentials(args):
    env = os.environ.get
    snow = {
        "instance_url": args.snow_instance_url or env("SNOW_INSTANCE_URL"),
        "username": args.snow_user or env("SNOW_USERNAME"),
        "password": args.snow_password or env("SNOW_PASSWORD"),
    }
    fga = {
        "api_url": env("FGA_API_URL", "https://api.us1.fga.dev"),
        "store_id": env("FGA_STORE_ID"),
        "model_id": env("FGA_MODEL_ID"),
        "client_id": env("FGA_CLIENT_ID"),
        "client_secret": env("FGA_CLIENT_SECRET"),
    }
    if args.use_ssm:
        import boto3
        session = boto3.Session(profile_name=args.aws_profile) if args.aws_profile else boto3.Session()
        ssm = session.client("ssm", region_name=args.aws_region)
        params = {}
        for page in ssm.get_paginator("get_parameters_by_path").paginate(
            Path=args.ssm_prefix.rstrip("/") + "/", WithDecryption=True
        ):
            for p in page.get("Parameters", []):
                params[p["Name"].split("/")[-1]] = p["Value"]
        snow["instance_url"] = snow["instance_url"] or params.get("servicenow_instance_url")
        snow["username"] = snow["username"] or params.get("servicenow_user")
        snow["password"] = snow["password"] or params.get("servicenow_password")
        fga["store_id"] = fga["store_id"] or params.get("fga_store_id")
        fga["model_id"] = fga["model_id"] or params.get("fga_model_id")
        fga["client_id"] = fga["client_id"] or params.get("fga_client_id")
        fga["client_secret"] = fga["client_secret"] or params.get("fga_client_secret")
        fga["api_url"] = params.get("fga_api_url") or fga["api_url"]
    missing = [k for k in ("instance_url", "username", "password") if not snow[k]]
    if missing:
        sys.exit(f"Missing ServiceNow credentials: {', '.join(missing)}. "
                 f"Use --use-ssm, env (SNOW_*), or --snow-* flags.")
    return snow, fga


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------
def _existing_sim_numbers(snow):
    """Return the set of in-use INC-4xxx integers (seed + prior simulator runs)."""
    rows = snow.query_table("incident", query="numberSTARTSWITHINC-4",
                            fields=["number"], limit=500)
    nums = set()
    for r in rows:
        n = r.get("number", "")
        if n.startswith("INC-"):
            try:
                nums.add(int(n[len("INC-"):]))
            except ValueError:
                pass
    return nums


def next_incident_number(snow):
    used = _existing_sim_numbers(snow)
    for n in range(SIM_NUMBER_MIN, SIM_NUMBER_MAX + 1):
        if n not in used:
            return f"INC-{n}"
    sys.exit(f"INC-{SIM_NUMBER_MIN}..{SIM_NUMBER_MAX} range exhausted — "
             f"run with --resolve-keep to clear old simulated incidents.")


def pick_account(explicit):
    if explicit:
        return explicit
    names = [a for a, _ in ACCOUNTS]
    weights = [w for _, w in ACCOUNTS]
    return random.choices(names, weights=weights, k=1)[0]


def pick_priority(explicit):
    if explicit:
        return explicit
    # Mostly P1/P2 (what the monitor flags), occasional P3.
    return random.choices(["P1", "P2", "P3"], weights=[0.45, 0.45, 0.10], k=1)[0]


def open_incident(snow, account, priority, dry_run, fga=None, agent_user=None):
    number = next_incident_number(snow)
    short, desc = random.choice(INCIDENT_TEMPLATES)
    impact, urgency = IMPACT_URGENCY[priority]
    data = {
        "number": number,
        "short_description": short.format(company=account),
        "description": desc.format(company=account),
        "impact": impact,
        "urgency": urgency,
        "state": "1",  # Open
        "company": account,
        "opened_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    }
    label = f"{number} [{priority}] {account} — {data['short_description']}"
    if dry_run:
        print(f"  [dry-run] would open  {label}")
        if fga and agent_user:
            print(f"  [dry-run] would grant user:{agent_user} viewer on snow_incident:{number.lower()}")
        return number
    sys_id = snow.create_record("incident", data)
    print(f"  opened  {label}  (sys_id {sys_id})")
    if fga and agent_user:
        fga.grant(f"user:{agent_user}", "viewer", f"snow_incident:{number.lower()}")
        print(f"  granted user:{agent_user} viewer on the new incident (so the monitor can see it)")
    return number


def resolve_old(snow, keep, dry_run):
    """Resolve simulated open incidents (INC-46xx+) beyond the newest `keep`."""
    rows = snow.query_table(
        "incident", query="numberSTARTSWITHINC-4^state=1^ORDERBYnumber",
        fields=["sys_id", "number", "company"], limit=200,
    )
    sim_open = []
    for r in rows:
        try:
            n = int(r["number"][len("INC-"):])
        except (ValueError, KeyError):
            continue
        if SIM_NUMBER_MIN <= n <= SIM_NUMBER_MAX:
            sim_open.append(r)
    to_resolve = sim_open[:-keep] if keep > 0 and len(sim_open) > keep else (sim_open if keep == 0 else [])
    failed = 0
    for r in to_resolve:
        if dry_run:
            print(f"  [dry-run] would resolve {r['number']} ({r.get('company','')})")
            continue
        try:
            snow.update_record("incident", r["sys_id"], {
                "state": "6",  # Resolved
                # Must be a value from the instance's incident close_code choice
                # list. "Solved (Permanently)" no longer exists on current
                # releases; an invalid value trips the mandatory-Resolution-code
                # data policy (403).
                "close_code": "Solution provided",
                "close_notes": "Auto-resolved by activity simulator (demo housekeeping).",
            })
            print(f"  resolved {r['number']} ({r.get('company','')})")
        except InstanceHibernatingError:
            raise
        except Exception as e:
            # Housekeeping is best-effort: one stubborn record must not abort
            # the run (that is exactly what kept the nightly job red for weeks).
            failed += 1
            print(f"  WARNING: could not resolve {r['number']}: {e}", file=sys.stderr)
    if failed:
        print(f"  WARNING: {failed} incident(s) could not be resolved this run.", file=sys.stderr)
    return len(to_resolve) - failed


def main():
    ap = argparse.ArgumentParser(description="Simulate ServiceNow activity for the Account Risk Monitor demo.")
    ap.add_argument("--mode", choices=["run", "dry-run"], default="run")
    ap.add_argument("--count", type=int, default=1, help="Incidents to open this run (default 1).")
    ap.add_argument("--account", help="Force a specific account (default: weighted-random at-risk account).")
    ap.add_argument("--priority", choices=["P1", "P2", "P3"], help="Force a priority (default: mostly P1/P2).")
    ap.add_argument("--resolve-keep", type=int, default=4,
                    help="Resolve simulated open incidents beyond the newest N (default 4; 0 resolves all).")
    ap.add_argument("--no-resolve", action="store_true", help="Skip resolving old simulated incidents.")
    # FGA grant (so the monitor can actually read the new incident)
    ap.add_argument("--agent-user", default=DEFAULT_AGENT_USER,
                    help="FGA user to grant viewer on new incidents (default: the monitor agent).")
    ap.add_argument("--no-grant", action="store_true",
                    help="Skip the FGA grant (incident will be created but the monitor won't see it).")
    # Credentials
    ap.add_argument("--use-ssm", action="store_true", help="Load ServiceNow + FGA creds from SSM.")
    ap.add_argument("--ssm-prefix", default="/bedrock-xaa-demo")
    ap.add_argument("--aws-profile")
    ap.add_argument("--aws-region", default="us-east-2")
    ap.add_argument("--snow-instance-url")
    ap.add_argument("--snow-user")
    ap.add_argument("--snow-password")
    args = ap.parse_args()

    dry = args.mode == "dry-run"
    snow_creds, fga_creds = load_credentials(args)
    snow = ServiceNowClient(snow_creds["instance_url"], snow_creds["username"], snow_creds["password"])

    fga = None
    if not args.no_grant:
        if all(fga_creds.get(k) for k in ("store_id", "model_id", "client_id", "client_secret")):
            fga = FGAClient(fga_creds["api_url"], fga_creds["store_id"], fga_creds["model_id"],
                            fga_creds["client_id"], fga_creds["client_secret"])
        else:
            print("  WARNING: FGA creds not found — creating incidents WITHOUT granting the "
                  "monitor access (it won't see them). Provide FGA_* env / SSM, or pass --no-grant.")

    print(f"Activity simulator → {snow_creds['instance_url']}  (mode: {args.mode})")
    try:
        opened = []
        for _ in range(max(1, args.count)):
            account = pick_account(args.account)
            priority = pick_priority(args.priority)
            opened.append(open_incident(snow, account, priority, dry, fga, args.agent_user))

        if not args.no_resolve:
            resolve_old(snow, args.resolve_keep, dry)
    except InstanceHibernatingError as e:
        # A sleeping PDI is an expected overnight condition, not a job failure.
        # Exit 0 so the scheduled run shows a skip-with-warning instead of red;
        # the ::warning:: line surfaces it in the GitHub Actions summary.
        print(f"::warning::Skipping run: {e}")
        sys.exit(0)

    print(f"Done. Opened {len(opened)} incident(s): {', '.join(opened)}")


if __name__ == "__main__":
    main()
