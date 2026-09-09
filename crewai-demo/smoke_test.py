# ABOUTME: Smoke test for CrewAI Account Risk Monitor — validates token mint and MCP tool visibility.
# ABOUTME: Verifies that snow:write tools are properly gated by Okta policy (should be absent).

import os
import sys

from dotenv import load_dotenv
from okta_auth import get_agent_token, decode_scopes


def main():
    """
    Smoke test: mint a token, check granted scopes, connect to MCP backend, and verify tool access.
    """
    load_dotenv()

    print("=" * 70)
    print("CrewAI Account Risk Monitor - Smoke Test")
    print("=" * 70)

    # Step 1: Load configuration
    print("\n[1] Loading configuration...")
    token_url = os.environ.get("OKTA_TOKEN_URL")
    client_id = os.environ.get("OKTA_CLIENT_ID")
    mcp_url = os.environ.get("MCP_BACKEND_URL")
    requested_scopes = os.environ.get("MONITOR_SCOPES", "sfdc:read sfdc:write snow:read")

    if not all([token_url, client_id, mcp_url]):
        print("ERROR: Missing required environment variables.")
        print("  - OKTA_TOKEN_URL:", "SET" if token_url else "NOT SET")
        print("  - OKTA_CLIENT_ID:", "SET" if client_id else "NOT SET")
        print("  - MCP_BACKEND_URL:", "SET" if mcp_url else "NOT SET")
        sys.exit(1)

    print(f"  OKTA_TOKEN_URL: {token_url}")
    print(f"  OKTA_CLIENT_ID: {client_id[:20]}..." if len(client_id) > 20 else f"  OKTA_CLIENT_ID: {client_id}")
    print(f"  MCP_BACKEND_URL: {mcp_url}")
    print(f"  Requested scopes: {requested_scopes}")

    # Step 2: Mint access token
    print("\n[2] Minting access token via private_key_jwt...")
    try:
        token = get_agent_token(requested_scopes)
        print(f"  ✓ Token minted ({len(token)} chars)")
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        sys.exit(1)

    # Step 3: Decode and verify scopes
    print("\n[3] Decoding token and verifying granted scopes...")
    granted_scopes = decode_scopes(token)
    print(f"  Granted scopes: {granted_scopes}")

    if not granted_scopes:
        print("  WARNING: Could not decode scopes from token (may be opaque token)")
    else:
        print(f"  ✓ Decoded {len(granted_scopes)} scopes")

    # Step 4: Connect to MCP backend
    print("\n[4] Connecting to MCP backend...")
    try:
        from crewai_tools import MCPServerAdapter

        server_params = {
            "url": mcp_url,
            "transport": "streamable-http",
            "headers": {"Authorization": f"Bearer {token}"}
        }

        with MCPServerAdapter(server_params) as mcp_tools:
            print(f"  ✓ Connected to MCP backend")

            # Step 5: List available tools
            print("\n[5] Enumerating MCP tools...")
            tool_names = sorted([tool.name for tool in mcp_tools])
            print(f"  Total tools: {len(tool_names)}")
            for tool_name in tool_names:
                print(f"    - {tool_name}")

            # Step 6: Verify snow:write tools are absent
            print("\n[6] Verifying snow:write tool gating...")
            restricted_tools = [
                "create_incident",
                "update_incident",
                "add_work_note"
            ]

            found_restricted = []
            for tool_name in tool_names:
                for restricted in restricted_tools:
                    if restricted in tool_name.lower():
                        found_restricted.append(tool_name)

            if found_restricted:
                print(f"  ✗ FAIL: snow:write tools visible: {found_restricted}")
                sys.exit(1)
            else:
                print(f"  ✓ PASS: snow:write tools absent (policy working)")

    except ImportError:
        print("  ✗ FAILED: crewai_tools not installed (expected in test environment)")
        print("     Install with: pip install -r requirements.txt")
        sys.exit(1)
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    print("\n" + "=" * 70)
    print("✓ Smoke test PASSED")
    print("=" * 70)


if __name__ == "__main__":
    main()
