#!/usr/bin/env python3
"""
Okta Event Hook → FGA Tuple Sync

This script can run as:
  1. AWS Lambda behind API Gateway (receives Okta Event Hooks)
  2. CLI tool for manual FGA grants/revokes

When a user is added to or removed from a Cowork group in Okta,
this function writes or deletes the corresponding FGA tuples so
the MCP server's per-tool and per-resource checks stay in sync.

Okta Event Hook events:
  - group.user_member.add    → write FGA tuples
  - group.user_member.remove → delete FGA tuples

=============================================================================
ARCHITECTURE
=============================================================================

  OIG Access Request
       ↓ (approved)
  Okta adds user to Cowork-CRM-Read group
       ↓
  Okta Event Hook fires (group.user_member.add)
       ↓
  API Gateway → This Lambda
       ↓
  FGA: write tuples (can_invoke_read on CRM tools, viewer on accounts)
       ↓
  Next MCP tool call → FGA check passes → user sees tools

=============================================================================
USAGE (CLI)
=============================================================================

  # Grant read access
  python3 fga_webhook.py --action grant --user bronko.nagurski@taskvantage.ai --level crm-read

  # Grant full access
  python3 fga_webhook.py --action grant --user bronko.nagurski@taskvantage.ai --level all

  # Revoke all access
  python3 fga_webhook.py --action revoke --user bronko.nagurski@taskvantage.ai

=============================================================================
LAMBDA DEPLOYMENT
=============================================================================

  Package with: pip install openfga-sdk -t package/ && zip -r fga_webhook.zip .
  Handler: fga_webhook.lambda_handler
  Runtime: Python 3.12
  Timeout: 30s
  Env vars: FGA_STORE_ID, FGA_MODEL_ID, FGA_CLIENT_ID, FGA_CLIENT_SECRET

"""

import asyncio
import json
import logging
import os
import sys
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# FGA credentials come from the environment (Lambda env vars or shell exports).
# There are deliberately no committed defaults for the store or credentials.
FGA_API_URL = os.environ.get("FGA_API_URL", "https://api.us1.fga.dev")
FGA_STORE_ID = os.environ.get("FGA_STORE_ID", "")
FGA_MODEL_ID = os.environ.get("FGA_MODEL_ID", "")
FGA_CLIENT_ID = os.environ.get("FGA_CLIENT_ID", "")
FGA_CLIENT_SECRET = os.environ.get("FGA_CLIENT_SECRET", "")

# Okta Event Hook verification key (set in Okta Event Hook config)
HOOK_VERIFICATION_KEY = os.environ.get("HOOK_VERIFICATION_KEY", "")

# ---------------------------------------------------------------------------
# Group → FGA Tuple Mapping
# ---------------------------------------------------------------------------
# Maps Okta group names to the FGA tuples that should be written/deleted.

# Read tools — Salesforce
CRM_READ_TOOLS = [
    "tool:search_accounts",
    "tool:get_account_details",
    "tool:search_opportunities",
    "tool:list_contacts",
]

# Write tools — Salesforce
CRM_WRITE_TOOLS = [
    "tool:create_opportunity",
    "tool:update_opportunity",
    "tool:log_activity",
]

# Read tools — ServiceNow
ITSM_READ_TOOLS = [
    "tool:search_incidents",
    "tool:get_incident",
    "tool:list_my_incidents",
    "tool:search_enhancements",
]

# Write tools — ServiceNow
ITSM_WRITE_TOOLS = [
    "tool:create_incident",
    "tool:update_incident",
    "tool:add_work_note",
]

# All Salesforce accounts (for viewer tuples)
ALL_ACCOUNTS = [
    "sfdc_account:acme-corp",
    "sfdc_account:pinnacle-financial",
    "sfdc_account:northstar-insurance",
    "sfdc_account:meridian-healthcare",
    "sfdc_account:apex-manufacturing",
]

# All ServiceNow incidents (for viewer tuples)
ALL_INCIDENTS = [
    "snow_incident:INC-4521",
    "snow_incident:INC-4518",
    "snow_incident:INC-4512",
    "snow_incident:INC-4505",
    "snow_incident:INC-4498",
]

# Group name → tuples to write
GROUP_TUPLE_MAP = {
    "Cowork-CRM-Read": {
        "tool_tuples": [(t, "can_invoke_read") for t in CRM_READ_TOOLS],
        "resource_tuples": [(a, "viewer") for a in ALL_ACCOUNTS],
    },
    "Cowork-CRM-Write": {
        "tool_tuples": (
            [(t, "can_invoke_read") for t in CRM_READ_TOOLS]
            + [(t, "can_invoke_write") for t in CRM_WRITE_TOOLS]
        ),
        "resource_tuples": (
            [(a, "viewer") for a in ALL_ACCOUNTS]
            + [(a, "editor") for a in ALL_ACCOUNTS]
        ),
    },
    "Cowork-ITSM-Read": {
        "tool_tuples": [(t, "can_invoke_read") for t in ITSM_READ_TOOLS],
        "resource_tuples": [(i, "viewer") for i in ALL_INCIDENTS],
    },
    "Cowork-ITSM-Write": {
        "tool_tuples": (
            [(t, "can_invoke_read") for t in ITSM_READ_TOOLS]
            + [(t, "can_invoke_write") for t in ITSM_WRITE_TOOLS]
        ),
        "resource_tuples": (
            [(i, "viewer") for i in ALL_INCIDENTS]
            + [(i, "editor") for i in ALL_INCIDENTS]
        ),
    },
}


# ---------------------------------------------------------------------------
# FGA Client
# ---------------------------------------------------------------------------
async def get_fga_client():
    from openfga_sdk import ClientConfiguration, OpenFgaClient
    from openfga_sdk.credentials import Credentials, CredentialConfiguration

    config = ClientConfiguration(
        api_url=FGA_API_URL,
        store_id=FGA_STORE_ID,
        authorization_model_id=FGA_MODEL_ID,
        credentials=Credentials(
            method="client_credentials",
            configuration=CredentialConfiguration(
                api_issuer="auth.fga.dev",
                api_audience="https://api.us1.fga.dev/",
                client_id=FGA_CLIENT_ID,
                client_secret=FGA_CLIENT_SECRET,
            ),
        ),
    )
    return OpenFgaClient(config)


async def write_tuples(user_email: str, group_name: str):
    """Write FGA tuples for a user being added to a group."""
    from openfga_sdk.client.models import ClientWriteRequest, ClientTuple

    mapping = GROUP_TUPLE_MAP.get(group_name)
    if not mapping:
        logger.warning(f"No FGA mapping for group: {group_name}")
        return 0

    fga_user = f"user:{user_email}"
    tuples = []

    for obj, relation in mapping["tool_tuples"]:
        tuples.append(ClientTuple(user=fga_user, relation=relation, object=obj))

    for obj, relation in mapping["resource_tuples"]:
        tuples.append(ClientTuple(user=fga_user, relation=relation, object=obj))

    written = 0
    async with await get_fga_client() as fga:
        for t in tuples:
            try:
                await fga.write(ClientWriteRequest(writes=[t]))
                written += 1
            except Exception as e:
                if "already exists" in str(e).lower():
                    pass  # idempotent
                else:
                    logger.error(f"Failed to write tuple: {t.user} -> {t.relation} -> {t.object}: {e}")

    logger.info(f"Wrote {written}/{len(tuples)} tuples for {user_email} (group: {group_name})")
    return written


async def delete_tuples(user_email: str, group_name: Optional[str] = None):
    """Delete FGA tuples for a user being removed from a group (or all groups)."""
    from openfga_sdk.client.models import ClientWriteRequest, ClientTuple

    fga_user = f"user:{user_email}"

    # If no specific group, delete tuples for ALL groups
    groups = [group_name] if group_name else list(GROUP_TUPLE_MAP.keys())

    all_tuples = []
    for g in groups:
        mapping = GROUP_TUPLE_MAP.get(g)
        if not mapping:
            continue
        for obj, relation in mapping["tool_tuples"]:
            all_tuples.append(ClientTuple(user=fga_user, relation=relation, object=obj))
        for obj, relation in mapping["resource_tuples"]:
            all_tuples.append(ClientTuple(user=fga_user, relation=relation, object=obj))

    deleted = 0
    async with await get_fga_client() as fga:
        for t in all_tuples:
            try:
                await fga.write(ClientWriteRequest(deletes=[t]))
                deleted += 1
            except Exception:
                pass  # tuple may not exist

    logger.info(f"Deleted {deleted}/{len(all_tuples)} tuples for {user_email}")
    return deleted


# ---------------------------------------------------------------------------
# Okta Event Hook Handler
# ---------------------------------------------------------------------------
def parse_okta_event(event_body: dict) -> list[dict]:
    """Extract user/group info from Okta Event Hook payload."""
    results = []
    for event in event_body.get("data", {}).get("events", []):
        event_type = event.get("eventType", "")
        if event_type not in ("group.user_member.add", "group.user_member.remove"):
            continue

        # Extract user email and group name from the target array
        user_email = None
        group_name = None
        for target in event.get("target", []):
            if target.get("type") == "User":
                user_email = target.get("alternateId")
            elif target.get("type") == "UserGroup":
                group_name = target.get("displayName")

        if user_email and group_name:
            action = "grant" if "add" in event_type else "revoke"
            results.append({
                "action": action,
                "user_email": user_email,
                "group_name": group_name,
            })

    return results


# ---------------------------------------------------------------------------
# Lambda Handler
# ---------------------------------------------------------------------------
def lambda_handler(event, context):
    """AWS Lambda entry point for Okta Event Hook."""

    # Handle Okta Event Hook verification challenge
    headers = event.get("headers", {})
    if headers.get("x-okta-verification-challenge"):
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "verification": headers["x-okta-verification-challenge"]
            }),
        }

    # Parse the event body
    body = json.loads(event.get("body", "{}"))
    actions = parse_okta_event(body)

    results = []
    for action in actions:
        if action["action"] == "grant":
            count = asyncio.get_event_loop().run_until_complete(
                write_tuples(action["user_email"], action["group_name"])
            )
        else:
            count = asyncio.get_event_loop().run_until_complete(
                delete_tuples(action["user_email"], action["group_name"])
            )
        results.append({**action, "tuples_affected": count})

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"processed": len(results), "results": results}),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    parser = argparse.ArgumentParser(description="FGA tuple sync for Okta group changes")
    parser.add_argument("--action", choices=["grant", "revoke"], required=True)
    parser.add_argument("--user", required=True, help="User email (e.g., bronko.nagurski@taskvantage.ai)")
    parser.add_argument("--level", choices=["crm-read", "crm-write", "itsm-read", "itsm-write", "all"],
                        default="all", help="Access level to grant/revoke")
    args = parser.parse_args()

    level_to_groups = {
        "crm-read": ["Cowork-CRM-Read"],
        "crm-write": ["Cowork-CRM-Write"],
        "itsm-read": ["Cowork-ITSM-Read"],
        "itsm-write": ["Cowork-ITSM-Write"],
        "all": list(GROUP_TUPLE_MAP.keys()),
    }

    groups = level_to_groups[args.level]

    for group in groups:
        if args.action == "grant":
            count = asyncio.run(write_tuples(args.user, group))
            print(f"Granted {group}: {count} tuples written")
        else:
            count = asyncio.run(delete_tuples(args.user, group))
            print(f"Revoked {group}: {count} tuples deleted")


if __name__ == "__main__":
    main()
