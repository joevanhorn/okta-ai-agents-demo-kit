#!/usr/bin/env python3
"""
Setup Okta FGA — creates authorization model and writes tuples.

Usage:
  python3 scripts/setup_fga.py
"""

import asyncio
import json
import os
from openfga_sdk import ClientConfiguration, OpenFgaClient
from openfga_sdk.client.models import ClientWriteRequest, ClientTuple, ClientCheckRequest
from openfga_sdk.credentials import Credentials, CredentialConfiguration

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# All values come from the environment. FGA_CLIENT_SECRET is required; there is
# deliberately no committed default for it.
FGA_API_URL = os.environ.get("FGA_API_URL", "https://api.us1.fga.dev")
FGA_STORE_ID = os.environ.get("FGA_STORE_ID", "")
FGA_CLIENT_ID = os.environ.get("FGA_CLIENT_ID", "")
FGA_CLIENT_SECRET = os.environ.get("FGA_CLIENT_SECRET", "")

if not (FGA_STORE_ID and FGA_CLIENT_ID and FGA_CLIENT_SECRET):
    raise SystemExit(
        "Set FGA_STORE_ID, FGA_CLIENT_ID, and FGA_CLIENT_SECRET in the environment "
        "before running this script (see mcp-server/.env.example)."
    )

# ---------------------------------------------------------------------------
# Authorization Model
# ---------------------------------------------------------------------------
AUTH_MODEL = {
    "schema_version": "1.1",
    "type_definitions": [
        {
            "type": "user",
        },
        {
            "type": "team",
            "relations": {
                "member": {
                    "this": {}
                }
            },
            "metadata": {
                "relations": {
                    "member": {
                        "directly_related_user_types": [
                            {"type": "user"}
                        ]
                    }
                }
            }
        },
        {
            "type": "tool",
            "relations": {
                "can_invoke": {
                    "union": {
                        "child": [
                            {"this": {}},
                            {"computedUserset": {"relation": "can_invoke_read"}},
                            {"computedUserset": {"relation": "can_invoke_write"}}
                        ]
                    }
                },
                "can_invoke_read": {
                    "this": {}
                },
                "can_invoke_write": {
                    "this": {}
                }
            },
            "metadata": {
                "relations": {
                    "can_invoke": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "user", "wildcard": {}},
                            {"type": "team", "relation": "member"}
                        ]
                    },
                    "can_invoke_read": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "user", "wildcard": {}},
                            {"type": "team", "relation": "member"}
                        ]
                    },
                    "can_invoke_write": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "user", "wildcard": {}},
                            {"type": "team", "relation": "member"}
                        ]
                    }
                }
            }
        },
        {
            "type": "sfdc_account",
            "relations": {
                "owner": {
                    "this": {}
                },
                "viewer": {
                    "union": {
                        "child": [
                            {"this": {}},
                            {"computedUserset": {"relation": "owner"}}
                        ]
                    }
                },
                "editor": {
                    "union": {
                        "child": [
                            {"this": {}},
                            {"computedUserset": {"relation": "owner"}}
                        ]
                    }
                }
            },
            "metadata": {
                "relations": {
                    "owner": {
                        "directly_related_user_types": [
                            {"type": "user"}
                        ]
                    },
                    "viewer": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "user", "wildcard": {}},
                            {"type": "team", "relation": "member"}
                        ]
                    },
                    "editor": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "team", "relation": "member"}
                        ]
                    }
                }
            }
        },
        {
            "type": "snow_incident",
            "relations": {
                "assignee": {
                    "this": {}
                },
                "viewer": {
                    "union": {
                        "child": [
                            {"this": {}},
                            {"computedUserset": {"relation": "assignee"}}
                        ]
                    }
                },
                "editor": {
                    "union": {
                        "child": [
                            {"this": {}},
                            {"computedUserset": {"relation": "assignee"}}
                        ]
                    }
                }
            },
            "metadata": {
                "relations": {
                    "assignee": {
                        "directly_related_user_types": [
                            {"type": "user"}
                        ]
                    },
                    "viewer": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "user", "wildcard": {}},
                            {"type": "team", "relation": "member"}
                        ]
                    },
                    "editor": {
                        "directly_related_user_types": [
                            {"type": "user"},
                            {"type": "team", "relation": "member"}
                        ]
                    }
                }
            }
        }
    ]
}

# ---------------------------------------------------------------------------
# Tuples — the authorization data
# ---------------------------------------------------------------------------
TUPLES = [
    # Teams
    ("user:joe.vanhorn@okta.com", "member", "team:leadership"),
    ("user:deku.midoriya@taskvantage.ai", "member", "team:product"),
    ("user:derek.jeter@taskvantage.ai", "member", "team:west-enterprise"),
    ("user:bernie.williams@taskvantage.ai", "member", "team:east-enterprise"),
    ("user:andy.pettitte@taskvantage.ai", "member", "team:west-enterprise"),
    ("user:chili.davis@taskvantage.ai", "member", "team:mid-market"),

    # Tool invocations — Product team: read all tools
    ("team:product#member", "can_invoke_read", "tool:search_accounts"),
    ("team:product#member", "can_invoke_read", "tool:get_account_details"),
    ("team:product#member", "can_invoke_read", "tool:search_opportunities"),
    ("team:product#member", "can_invoke_read", "tool:list_contacts"),
    ("team:product#member", "can_invoke_read", "tool:search_incidents"),
    ("team:product#member", "can_invoke_read", "tool:get_incident"),
    ("team:product#member", "can_invoke_read", "tool:list_my_incidents"),
    ("team:product#member", "can_invoke_read", "tool:search_enhancements"),

    # Tool invocations — Leadership: read + write all tools
    ("team:leadership#member", "can_invoke_read", "tool:search_accounts"),
    ("team:leadership#member", "can_invoke_read", "tool:get_account_details"),
    ("team:leadership#member", "can_invoke_read", "tool:search_opportunities"),
    ("team:leadership#member", "can_invoke_read", "tool:list_contacts"),
    ("team:leadership#member", "can_invoke_read", "tool:search_incidents"),
    ("team:leadership#member", "can_invoke_read", "tool:get_incident"),
    ("team:leadership#member", "can_invoke_read", "tool:list_my_incidents"),
    ("team:leadership#member", "can_invoke_read", "tool:search_enhancements"),
    ("team:leadership#member", "can_invoke_write", "tool:create_opportunity"),
    ("team:leadership#member", "can_invoke_write", "tool:update_opportunity"),
    ("team:leadership#member", "can_invoke_write", "tool:log_activity"),
    ("team:leadership#member", "can_invoke_write", "tool:create_incident"),
    ("team:leadership#member", "can_invoke_write", "tool:update_incident"),
    ("team:leadership#member", "can_invoke_write", "tool:add_work_note"),

    # Tool invocations — Sales teams: read + write CRM only
    ("team:west-enterprise#member", "can_invoke_read", "tool:search_accounts"),
    ("team:west-enterprise#member", "can_invoke_read", "tool:get_account_details"),
    ("team:west-enterprise#member", "can_invoke_read", "tool:search_opportunities"),
    ("team:west-enterprise#member", "can_invoke_read", "tool:list_contacts"),
    ("team:west-enterprise#member", "can_invoke_write", "tool:create_opportunity"),
    ("team:west-enterprise#member", "can_invoke_write", "tool:update_opportunity"),
    ("team:west-enterprise#member", "can_invoke_write", "tool:log_activity"),
    ("team:east-enterprise#member", "can_invoke_read", "tool:search_accounts"),
    ("team:east-enterprise#member", "can_invoke_read", "tool:get_account_details"),
    ("team:east-enterprise#member", "can_invoke_read", "tool:search_opportunities"),
    ("team:east-enterprise#member", "can_invoke_read", "tool:list_contacts"),
    ("team:east-enterprise#member", "can_invoke_write", "tool:create_opportunity"),
    ("team:east-enterprise#member", "can_invoke_write", "tool:update_opportunity"),
    ("team:east-enterprise#member", "can_invoke_write", "tool:log_activity"),

    # Account ownership (territory model)
    ("user:derek.jeter@taskvantage.ai", "owner", "sfdc_account:acme-corp"),
    ("user:derek.jeter@taskvantage.ai", "owner", "sfdc_account:pinnacle-financial"),
    ("user:bernie.williams@taskvantage.ai", "owner", "sfdc_account:northstar-insurance"),
    ("user:andy.pettitte@taskvantage.ai", "owner", "sfdc_account:meridian-healthcare"),
    ("user:chili.davis@taskvantage.ai", "owner", "sfdc_account:apex-manufacturing"),

    # Product team can VIEW all accounts (but not edit)
    ("team:product#member", "viewer", "sfdc_account:acme-corp"),
    ("team:product#member", "viewer", "sfdc_account:pinnacle-financial"),
    ("team:product#member", "viewer", "sfdc_account:northstar-insurance"),
    ("team:product#member", "viewer", "sfdc_account:meridian-healthcare"),
    ("team:product#member", "viewer", "sfdc_account:apex-manufacturing"),

    # Leadership can view all accounts
    ("team:leadership#member", "viewer", "sfdc_account:acme-corp"),
    ("team:leadership#member", "viewer", "sfdc_account:pinnacle-financial"),
    ("team:leadership#member", "viewer", "sfdc_account:northstar-insurance"),
    ("team:leadership#member", "viewer", "sfdc_account:meridian-healthcare"),
    ("team:leadership#member", "viewer", "sfdc_account:apex-manufacturing"),

    # Incident access — product team can view all
    ("team:product#member", "viewer", "snow_incident:INC-4521"),
    ("team:product#member", "viewer", "snow_incident:INC-4518"),
    ("team:product#member", "viewer", "snow_incident:INC-4512"),
    ("team:product#member", "viewer", "snow_incident:INC-4505"),
    ("team:product#member", "viewer", "snow_incident:INC-4498"),

    # Incident assignees
    ("user:lance.briggs@taskvantage.ai", "assignee", "snow_incident:INC-4521"),
    ("user:devin.hester@taskvantage.ai", "assignee", "snow_incident:INC-4518"),
    ("user:brian.urlacher@taskvantage.ai", "assignee", "snow_incident:INC-4512"),
    ("user:charles.tillman@taskvantage.ai", "assignee", "snow_incident:INC-4505"),
    ("user:jay.cutler@taskvantage.ai", "assignee", "snow_incident:INC-4498"),
]


async def main():
    # Connect to FGA
    config = ClientConfiguration(
        api_url=FGA_API_URL,
        store_id=FGA_STORE_ID,
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

    async with OpenFgaClient(config) as fga:
        # Step 1: Write the authorization model
        print("Writing authorization model...")
        resp = await fga.write_authorization_model(AUTH_MODEL)
        model_id = resp.authorization_model_id
        print(f"  Model created: {model_id}")

        # Step 2: Write tuples in batches (max 100 per request)
        print(f"\nWriting {len(TUPLES)} tuples...")
        batch_size = 100
        for i in range(0, len(TUPLES), batch_size):
            batch = TUPLES[i:i + batch_size]
            writes = [
                ClientTuple(user=user, relation=relation, object=obj)
                for user, relation, obj in batch
            ]
            try:
                await fga.write(ClientWriteRequest(writes=writes))
                print(f"  Wrote batch {i // batch_size + 1}: {len(batch)} tuples")
            except Exception as e:
                print(f"  Batch {i // batch_size + 1} error: {e}")
                # Try one-by-one for the failed batch
                for user, relation, obj in batch:
                    try:
                        await fga.write(ClientWriteRequest(
                            writes=[ClientTuple(user=user, relation=relation, object=obj)]
                        ))
                    except Exception as e2:
                        print(f"    Skip (may already exist): {user} -> {relation} -> {obj}")

        # Step 3: Verify with sample checks
        print("\nVerifying authorization checks...")
        checks = [
            ("user:deku.midoriya@taskvantage.ai", "can_invoke_read", "tool:search_accounts", True),
            ("user:deku.midoriya@taskvantage.ai", "can_invoke_write", "tool:create_opportunity", False),
            ("user:deku.midoriya@taskvantage.ai", "viewer", "sfdc_account:acme-corp", True),
            ("user:derek.jeter@taskvantage.ai", "owner", "sfdc_account:acme-corp", True),
            ("user:derek.jeter@taskvantage.ai", "owner", "sfdc_account:northstar-insurance", False),
            ("user:bernie.williams@taskvantage.ai", "editor", "sfdc_account:northstar-insurance", True),
            ("user:joe.vanhorn@okta.com", "can_invoke_write", "tool:update_opportunity", True),
        ]

        all_pass = True
        for user, relation, obj, expected in checks:
            resp = await fga.check(ClientCheckRequest(
                user=user, relation=relation, object=obj
            ))
            result = resp.allowed
            status = "PASS" if result == expected else "FAIL"
            if status == "FAIL":
                all_pass = False
            print(f"  {status}: {user} -> {relation} -> {obj} = {result} (expected {expected})")

        print(f"\nModel ID: {model_id}")
        print(f"All checks passed: {all_pass}")


if __name__ == "__main__":
    asyncio.run(main())
