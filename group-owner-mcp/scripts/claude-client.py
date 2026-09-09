#!/usr/bin/env python3
"""
Connect a Claude instance to the group-owner-mcp tools (local bridge).

Speaks JSON-RPC to the server's /mcp endpoint, sends the ACTING USER's identity
as the bearer token, hands the three tools to Claude, and runs the tool loop.
Switch DEMO_USER to show the same request being allowed (an owner) or denied
(a non-owner) purely on identity — the prompt can't change it.

Usage:
  export ANTHROPIC_API_KEY=sk-ant-...              # required
  export DEMO_USER=00uALICE                        # who you're acting as
  python3 scripts/claude-client.py "What groups do I own?"   # one-shot
  python3 scripts/claude-client.py                 # interactive REPL

Env:
  GROUP_OWNER_MCP_URL  default http://localhost:8080/mcp
  DEMO_USER            default 00uALICE   (owns Contractors + Project-Phoenix)
                       try  00uBOB        (owns nothing Alice owns -> denials)
  CLAUDE_MODEL         default claude-opus-4-8
"""
import os
import sys
import json
import httpx
import anthropic

MCP_URL = os.environ.get("GROUP_OWNER_MCP_URL", "http://localhost:8080/mcp")
DEMO_USER = os.environ.get("DEMO_USER", "00uALICE")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-4-8")

SYSTEM = (
    "You help an Okta group OWNER manage the membership of groups they own, using "
    "only the provided tools. You have no admin powers beyond these tools. Use "
    "list_my_owned_groups to discover which groups the caller owns. Never claim you "
    "performed an action the tools did not confirm. If a tool denies access, report "
    "that plainly and do not try to work around it."
)


def mcp(method, params=None):
    r = httpx.post(
        MCP_URL,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={"Authorization": f"Bearer {DEMO_USER}"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def load_tools():
    return [
        {"name": t["name"], "description": t["description"], "input_schema": t["inputSchema"]}
        for t in mcp("tools/list")["tools"]
    ]


def run(client, tools, messages):
    while True:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            thinking={"type": "adaptive"},
            system=SYSTEM,
            tools=tools,
            messages=messages,
        )
        if resp.stop_reason != "tool_use":
            text = next((b.text for b in resp.content if b.type == "text"), "")
            print(f"\nClaude: {text}\n")
            messages.append({"role": "assistant", "content": resp.content})
            return
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                print(f"  → {b.name}({json.dumps(b.input)})")
                out = mcp("tools/call", {"name": b.name, "arguments": b.input})
                text = "\n".join(c.get("text", "") for c in out.get("content", []))
                is_err = bool(out.get("isError"))
                print(f"    [{'DENIED' if is_err else 'ok'}] {text.splitlines()[0] if text else ''}")
                results.append(
                    {"type": "tool_result", "tool_use_id": b.id, "content": text, "is_error": is_err}
                )
        messages.append({"role": "user", "content": results})


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ERROR: set ANTHROPIC_API_KEY first (export ANTHROPIC_API_KEY=sk-ant-...).")
    client = anthropic.Anthropic()
    try:
        tools = load_tools()
    except Exception as e:
        sys.exit(f"ERROR: could not reach the MCP server at {MCP_URL}\n  {e}\n"
                 f"  Is the mock server running?  (cd ~/group-owner-mcp && npm run mock)")
    print(f"Connected to {MCP_URL}")
    print(f"Acting as Okta user: {DEMO_USER}   model: {MODEL}")
    print(f"Tools: {', '.join(t['name'] for t in tools)}\n")

    def safe_run(messages):
        try:
            run(client, tools, messages)
        except anthropic.AuthenticationError:
            sys.exit("ERROR: Anthropic rejected the API key. Check ANTHROPIC_API_KEY.")
        except anthropic.APIError as e:
            print(f"[Anthropic API error] {e}")

    if len(sys.argv) > 1:
        safe_run([{"role": "user", "content": " ".join(sys.argv[1:])}])
        return

    print("Interactive chat. Try:")
    print("  What groups do I own?")
    print("  Add bob@ext.com to Contractors, then show me who's in it.")
    print("  Show me who's in Executive-Comp.        (denied unless you own it)")
    print("Ctrl-D or Ctrl-C to quit.\n")
    messages = []
    while True:
        try:
            q = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not q:
            continue
        messages.append({"role": "user", "content": q})
        safe_run(messages)


if __name__ == "__main__":
    main()
