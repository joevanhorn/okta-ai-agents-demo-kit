# ABOUTME: CLI entrypoint for the CrewAI Account Risk Monitor (Sprint 2).
# ABOUTME: Supports single-pass (--once) and continuous-watch (--watch) modes.
# ABOUTME: Passes --act to enable the single Salesforce write action (log_activity).
# ABOUTME: This is a headless agent using the Resource-Server model: the Okta token
# ABOUTME: is minted via private_key_jwt client_credentials, then passed directly to
# ABOUTME: the MCP backend as a Bearer header — NOT via the adapter/OAuth flow.

import argparse
import os
import sys
import time
from datetime import datetime, timezone


def _print_banner(act: bool, scopes: str, interval: int | None, mode: str) -> None:
    """Print a startup banner with key operational parameters."""
    print("=" * 70)
    print("  Account Risk Monitor — CrewAI / MCP Backend")
    print("=" * 70)
    print(f"  Mode          : {mode}")
    print(f"  Scopes        : {scopes}")
    print(f"  Write enabled : {'YES — log_activity on highest-risk account' if act else 'NO — report only'}")
    print(f"  Backend URL   : {os.environ.get('MCP_BACKEND_URL', '(MCP_BACKEND_URL not set)')}")
    print(f"  LLM           : {os.environ.get('MONITOR_LLM', 'anthropic/claude-haiku-4-5-20251001')}")
    if interval is not None:
        print(f"  Watch interval: {interval}s")
    print()
    print("  Architecture  : Resource-Server model — token minted via Okta")
    print("                  private_key_jwt, passed as Bearer to MCP backend.")
    print("                  The backend scope-filters the tool list; ServiceNow")
    print("                  write tools are NOT visible with the default scopes.")
    print("=" * 70)
    print(flush=True)


def _pass_header(pass_num: int) -> None:
    """Print a timestamped header for a watch-mode pass."""
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print()
    print(f"{'─' * 70}")
    print(f"  Pass #{pass_num}  —  {ts}")
    print(f"{'─' * 70}", flush=True)


def main() -> None:
    # Load .env up front so the banner (and everything after) sees configured
    # values like MCP_BACKEND_URL, not just the process environment.
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(
        prog="run",
        description=(
            "Account Risk Monitor — CrewAI crew that checks ServiceNow incidents "
            "and Salesforce pipeline exposure on a schedule."
        ),
    )

    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--once",
        action="store_true",
        default=False,
        help="Run a single monitoring pass then exit (default if neither --once nor --watch given).",
    )
    mode_group.add_argument(
        "--watch",
        action="store_true",
        default=False,
        help=(
            "Loop forever, running a pass every WATCH_INTERVAL seconds "
            "(default 300). Re-mints the Okta token and re-opens the MCP "
            "adapter on each pass."
        ),
    )

    parser.add_argument(
        "--act",
        action="store_true",
        default=False,
        help=(
            "Enable the single write action: the Risk Reporter will call "
            "log_activity on the highest-risk Salesforce account after "
            "generating the briefing. Default is report-only."
        ),
    )

    parser.add_argument(
        "--interval",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Override the watch-mode interval in seconds (also overrides "
            "the WATCH_INTERVAL environment variable)."
        ),
    )

    args = parser.parse_args()

    # Resolve interval
    env_interval = int(os.environ.get("WATCH_INTERVAL", "300"))
    interval = args.interval if args.interval is not None else env_interval

    # Resolve mode: if neither flag given, default to --once
    watch_mode = args.watch
    mode_label = "WATCH" if watch_mode else "ONCE"
    act_label = "ACT" if args.act else "REPORT-ONLY"
    mode_display = f"{mode_label} / {act_label}"

    scopes = os.environ.get("MONITOR_SCOPES", "sfdc:read sfdc:write snow:read")

    _print_banner(
        act=args.act,
        scopes=scopes,
        interval=interval if watch_mode else None,
        mode=mode_display,
    )

    # Import here so startup banner prints before potentially slow imports
    from monitor_crew import run_monitor_pass

    if not watch_mode:
        # Single pass
        print("[run] Starting single monitoring pass …", flush=True)
        briefing = run_monitor_pass(act=args.act)
        print()
        print("=" * 70)
        print("  RISK BRIEFING")
        print("=" * 70)
        print(briefing)
        print("=" * 70)
    else:
        # Watch loop
        pass_num = 0
        print(f"[run] Watch mode active. Press Ctrl+C to stop.", flush=True)
        try:
            while True:
                pass_num += 1
                _pass_header(pass_num)
                try:
                    briefing = run_monitor_pass(act=args.act)
                    print()
                    print("── BRIEFING ──")
                    print(briefing)
                    print("── END BRIEFING ──", flush=True)
                except Exception as exc:
                    print(f"[run] ERROR during pass #{pass_num}: {exc}", file=sys.stderr, flush=True)

                print(
                    f"\n[run] Pass #{pass_num} complete. Next pass in {interval}s "
                    f"(Ctrl+C to stop) …",
                    flush=True,
                )
                time.sleep(interval)
        except KeyboardInterrupt:
            print(
                f"\n[run] Interrupted after {pass_num} pass(es). Exiting cleanly.",
                flush=True,
            )
            sys.exit(0)


if __name__ == "__main__":
    main()
