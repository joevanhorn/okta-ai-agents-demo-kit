# ABOUTME: CrewAI Account Risk Monitor — Sprint 2, monitoring crew.
# ABOUTME: Sequential crew of three agents: Incident Watcher, Account Correlator, Risk Reporter.
# ABOUTME: Connects to the MCP backend via streamable-http using a pre-minted Okta token.
# ABOUTME: The token is scoped to sfdc:read sfdc:write snow:read; the backend enforces this
# ABOUTME: so ServiceNow-write tools (create_incident, update_incident, add_work_note) are
# ABOUTME: never visible — do not depend on them.

import os
import sys

from crewai import Agent, Crew, Process, Task, LLM
from crewai_tools import MCPServerAdapter

from okta_auth import get_agent_token, decode_scopes, ensure_anthropic_key


def _build_llm() -> "LLM":
    """
    Build the CrewAI LLM. Supports two configurations:

    1. A direct provider key — set MONITOR_LLM (e.g. anthropic/claude-haiku-4-5-20251001)
       and the provider key in env (e.g. ANTHROPIC_API_KEY).
    2. A LiteLLM proxy / gateway key — set LITELLM_API_BASE to the proxy URL and
       LITELLM_API_KEY to the virtual/master key. MONITOR_LLM is the model name the
       proxy exposes (LiteLLM proxies are OpenAI-compatible, so prefix with
       "openai/" if the proxy serves it under that route, e.g. openai/claude-haiku).

    CrewAI's LLM is LiteLLM under the hood, so base_url + api_key route every call
    through the proxy.
    """
    model = os.environ.get("MONITOR_LLM", "anthropic/claude-haiku-4-5-20251001")
    kwargs = {"model": model}
    api_base = os.environ.get("LITELLM_API_BASE")
    api_key = os.environ.get("LITELLM_API_KEY")
    if api_base:
        kwargs["base_url"] = api_base
    if api_key:
        kwargs["api_key"] = api_key
    # For a direct Anthropic model, make sure the provider key is available —
    # fall back to SSM so the host needs no plaintext key on disk.
    if not api_base and model.startswith("anthropic/"):
        if not ensure_anthropic_key():
            print(
                "[monitor] WARNING: ANTHROPIC_API_KEY not found in env, .env, or SSM "
                "(/taskvantage-prod/crewai-monitor/anthropic-api-key). The LLM call will fail.",
                file=sys.stderr,
            )
    return LLM(**kwargs)


def run_monitor_pass(act: bool = False) -> str:
    """
    Execute a single monitoring pass of the Account Risk Monitor crew.

    Steps:
      1. Mint an Okta client_credentials token for the configured scopes.
      2. Log the granted scopes and (once the adapter is open) the visible tool names.
      3. Open an MCPServerAdapter over streamable-http with the token as a Bearer header.
      4. Build and kick off a sequential crew: Incident Watcher → Account Correlator →
         Risk Reporter.
      5. If act=True the Risk Reporter may log one Salesforce activity on the highest-risk
         account. If act=False it produces a read-only briefing.

    Args:
        act: When True, authorise the Risk Reporter to write one log_activity record.
             When False (default), produce a report-only briefing without any writes.

    Returns:
        str: The final risk briefing produced by the crew.
    """
    scopes = os.environ.get("MONITOR_SCOPES", "sfdc:read sfdc:write snow:read")

    # --- 1. Mint token and decode scopes ---
    print("[monitor] Minting Okta token …", flush=True)
    token = get_agent_token(scopes)
    granted_scopes = decode_scopes(token)
    print(f"[monitor] Granted scopes: {granted_scopes}", flush=True)

    # --- 2. Configure the MCP backend connection ---
    backend_url = os.environ["MCP_BACKEND_URL"]
    server_params = {
        "url": backend_url,
        "transport": "streamable-http",
        "headers": {"Authorization": f"Bearer {token}"},
    }

    # --- 3. Open adapter and print visible tools ---
    with MCPServerAdapter(server_params) as mcp_tools:
        visible_tool_names = [t.name for t in mcp_tools]
        print(
            f"[monitor] Visible tools ({len(visible_tool_names)}): {visible_tool_names}",
            flush=True,
        )
        # Sanity-check: warn if ServiceNow-write tools are unexpectedly present
        snow_write = {"create_incident", "update_incident", "add_work_note"}
        leaked = snow_write & set(visible_tool_names)
        if leaked:
            print(
                f"[monitor] WARNING: unexpected ServiceNow-write tools visible: {leaked}",
                flush=True,
            )

        # --- LLM (direct provider key or LiteLLM proxy; see _build_llm) ---
        llm = _build_llm()

        # --- 4. Build agents ---

        incident_watcher = Agent(
            role="Incident Watcher",
            goal=(
                "Find all open high-priority (P1 and P2) ServiceNow incidents and identify "
                "which customer accounts or companies are affected by each incident."
            ),
            backstory=(
                "You are an SRE on-call analyst. You monitor the ServiceNow queue for "
                "critical and high incidents and map each one to the affected customer. "
                "You use list_my_incidents to get an overview, search_incidents to filter "
                "by priority, and get_incident to fetch details including the affected company "
                "or account name."
            ),
            tools=mcp_tools,
            llm=llm,
            verbose=True,
        )

        account_correlator = Agent(
            role="Account Correlator",
            goal=(
                "For each customer account affected by an open P1/P2 incident, retrieve the "
                "Salesforce account details and all open opportunities, then calculate the "
                "total open pipeline (revenue exposure) tied to that account."
            ),
            backstory=(
                "You are a revenue-risk analyst who links support incidents to pipeline risk. "
                "Given a list of affected customer names, you use search_accounts to find the "
                "Salesforce account, get_account_details for firmographics, search_opportunities "
                "for open deals, and list_contacts to understand the relationship depth. "
                "You produce a structured summary: account name, open opportunity count, "
                "total pipeline value, and key contacts."
            ),
            tools=mcp_tools,
            llm=llm,
            verbose=True,
        )

        # Act-aware instructions for the Risk Reporter
        if act:
            write_instruction = (
                "You ARE authorized to take one write action: call log_activity on the single "
                "highest-risk Salesforce account to record a note that an open critical incident "
                "is affecting it and warrants immediate attention. Log the incident number and "
                "the approximate pipeline value at risk in the activity note. Do this AFTER "
                "producing the briefing text."
            )
        else:
            write_instruction = (
                "Do NOT modify any records. You are in report-only mode. "
                "Do not call log_activity, create_opportunity, or update_opportunity. "
                "Produce the risk briefing as text only."
            )

        risk_reporter = Agent(
            role="Risk Reporter",
            goal=(
                "Synthesise a concise, ranked risk briefing that lists the top at-risk accounts, "
                "the incident affecting each, the estimated revenue exposure, and a recommended "
                "next action for each. If no incidents were found, report an all-clear."
            ),
            backstory=(
                "You are a customer-success operations manager who turns raw incident and "
                "pipeline data into executive-ready risk briefings. You rank accounts by "
                "combined severity (incident priority × open pipeline), write clearly and "
                "concisely, and surface the one action each account team must take next. "
                f"{write_instruction}"
            ),
            tools=mcp_tools,
            llm=llm,
            verbose=True,
        )

        # --- 5. Build tasks ---

        task_watch = Task(
            description=(
                "Search ServiceNow for all currently open incidents with priority P1 or P2. "
                "Use list_my_incidents for an initial list, then search_incidents to filter "
                "for high-priority open items, then get_incident on each to collect: incident "
                "number, short description, priority, state, and the affected customer or "
                "company name. If you find no P1/P2 incidents, clearly state 'No open "
                "high-priority incidents found.'"
            ),
            expected_output=(
                "A list of open P1/P2 incidents, each with: incident number, priority, "
                "short description, and affected customer/company name. "
                "If none exist, output: 'No open high-priority incidents found.'"
            ),
            agent=incident_watcher,
        )

        task_correlate = Task(
            description=(
                "Using the incident list from the previous step, look up each affected customer "
                "in Salesforce. For each customer: use search_accounts to find the account, "
                "get_account_details for account health/tier info, search_opportunities for "
                "all open (non-closed) opportunities, and list_contacts to note key contacts. "
                "Calculate total open pipeline value per account. "
                "If no incidents were found upstream, output 'No accounts to correlate.'"
            ),
            expected_output=(
                "For each affected customer: Salesforce account name, account tier/industry, "
                "number of open opportunities, total open pipeline value (sum of amounts), "
                "and key contact names. If no incidents were upstream, state: "
                "'No accounts to correlate.'"
            ),
            agent=account_correlator,
        )

        act_note = (
            "After writing the briefing, call log_activity on the single highest-risk account "
            "to record the incident and pipeline exposure."
            if act
            else "Do not call any write tools; produce text only."
        )

        task_report = Task(
            description=(
                "Using the incident details and account/pipeline data from the previous steps, "
                "produce a ranked risk briefing. "
                "Rank accounts from highest to lowest risk (P1 incident + largest pipeline first). "
                "For each account include: rank, account name, incident number + description, "
                "open pipeline value, and a one-sentence recommended action. "
                "If the upstream steps reported no incidents, output a clear all-clear message. "
                f"{act_note}"
            ),
            expected_output=(
                "A ranked risk briefing titled 'Account Risk Briefing — <date>'. "
                "Each entry: rank, account name, incident (number + one-line description), "
                "pipeline at risk ($), recommended action. "
                "Footer: total accounts reviewed, total pipeline at risk, "
                "mode (REPORT-ONLY or ACT). "
                "If no incidents: a single all-clear paragraph."
            ),
            agent=risk_reporter,
        )

        # --- 6. Build and run crew ---
        crew = Crew(
            agents=[incident_watcher, account_correlator, risk_reporter],
            tasks=[task_watch, task_correlate, task_report],
            process=Process.sequential,
            verbose=True,
        )

        result = crew.kickoff()
        return str(result)
