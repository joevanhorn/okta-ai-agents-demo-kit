/**
 * ServiceNow MCP tools — registered with scope metadata.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import * as snow from "./client.js";

// ---------------------------------------------------------------------------
// Read tools (snow:read)
// ---------------------------------------------------------------------------

registerTool({
  name: "search_incidents",
  description: "Search ServiceNow incidents by keyword, customer, or priority. Returns incident number, description, priority, state, and assignee.",
  requiredScope: "snow:read",
  operation: "read",
  inputSchema: z.object({
    query: z.string().describe("Keyword to search (matches description, company, number)"),
    priority: z.string().optional().describe("Priority filter: 'P1', 'P2', 'P3', 'all' (default: all)"),
  }),
  async handler({ query, priority }) {
    const escaped = query.replace(/'/g, "\\'");
    const conditions = [
      `short_descriptionLIKE${escaped}`,
      `companyLIKE${escaped}`,
      `numberLIKE${escaped}`,
      `descriptionLIKE${escaped}`,
    ];
    let snowQuery = conditions.join("^OR");

    // Exclude enhancements (stored as incidents with category=Enhancement)
    snowQuery += "^category!=Enhancement";

    // Filter to our seeded incidents
    snowQuery += "^numberSTARTSWITHINC-4";

    // Priority filter
    const p = (priority || "all").toUpperCase().replace("P", "");
    if (["1", "2", "3", "4", "5"].includes(p)) {
      snowQuery += `^priority=${p}`;
    }

    const records = await snow.queryTable(
      "incident",
      snowQuery,
      ["number", "short_description", "priority", "state", "assigned_to", "company", "opened_at", "made_sla"],
      20
    );

    return {
      incidents: records.map((r: any) => ({
        number: r.number,
        short_description: r.short_description,
        priority: r.priority,
        state: r.state,
        assigned_to: snow.displayValue(r.assigned_to),
        company: snow.displayValue(r.company),
        opened_at: r.opened_at,
        sla_breach: r.made_sla === "false",
      })),
      total: records.length,
    };
  },
});

registerTool({
  name: "get_incident",
  description: "Get full details for a specific ServiceNow incident by number (e.g. INC-4521).",
  requiredScope: "snow:read",
  operation: "read",
  inputSchema: z.object({
    incident_number: z.string().describe("Incident number (e.g. INC-4521)"),
  }),
  async handler({ incident_number }) {
    const records = await snow.queryTable(
      "incident",
      `number=${incident_number.toUpperCase()}`,
      ["number", "short_description", "description", "priority", "state",
       "assigned_to", "assignment_group", "company", "opened_at", "sys_updated_on", "made_sla", "escalation"],
      1
    );

    if (!records.length) return { error: `Incident not found: ${incident_number}` };
    const r = records[0];

    return {
      number: r.number,
      short_description: r.short_description,
      description: r.description,
      priority: r.priority,
      state: r.state,
      assigned_to: snow.displayValue(r.assigned_to),
      assignment_group: snow.displayValue(r.assignment_group),
      company: snow.displayValue(r.company),
      opened_at: r.opened_at,
      updated_at: r.sys_updated_on,
      sla_breach: r.made_sla === "false",
      escalated: r.escalation === "1",
    };
  },
});

registerTool({
  name: "list_my_incidents",
  description: "List all open incidents, optionally filtered by priority.",
  requiredScope: "snow:read",
  operation: "read",
  inputSchema: z.object({
    priority: z.string().optional().describe("Priority filter: 'P1', 'P2', 'P3', 'all' (default: all)"),
  }),
  async handler({ priority }) {
    let snowQuery = "numberSTARTSWITHINC-4^category!=Enhancement^stateIN1,2";
    const p = (priority || "all").toUpperCase().replace("P", "");
    if (["1", "2", "3", "4", "5"].includes(p)) {
      snowQuery += `^priority=${p}`;
    }

    const records = await snow.queryTable(
      "incident",
      snowQuery,
      ["number", "short_description", "priority", "state", "assigned_to", "company", "opened_at"],
      50
    );

    return {
      incidents: records.map((r: any) => ({
        number: r.number,
        short_description: r.short_description,
        priority: r.priority,
        state: r.state,
        assigned_to: snow.displayValue(r.assigned_to),
        company: snow.displayValue(r.company),
        opened_at: r.opened_at,
      })),
      total: records.length,
    };
  },
});

registerTool({
  name: "search_enhancements",
  description: "Search product enhancement requests by keyword, customer, or product area. Ranked by vote count.",
  requiredScope: "snow:read",
  operation: "read",
  inputSchema: z.object({
    query: z.string().describe("Keyword to search (matches title, description, customer, product area). Use 'all' for all enhancements."),
  }),
  async handler({ query }) {
    const escaped = query.replace(/'/g, "\\'");
    let snowQuery: string;
    if (query.toLowerCase() === "all") {
      snowQuery = "numberSTARTSWITHENH";
    } else {
      const conditions = [
        `short_descriptionLIKE${escaped}`,
        `descriptionLIKE${escaped}`,
        `companyLIKE${escaped}`,
      ];
      snowQuery = conditions.join("^OR") + "^numberSTARTSWITHENH";
    }

    const records = await snow.queryTable(
      "incident",
      snowQuery,
      ["number", "short_description", "description", "priority", "company", "category", "subcategory", "opened_at"],
      20
    );

    // Parse vote count and metadata from description
    const enhancements = records.map((r: any) => {
      const desc = r.description || "";
      let votes = 0;
      let productArea = r.subcategory || "";
      let requestedBy = "";
      let status = "";

      for (const line of desc.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Votes:")) votes = parseInt(trimmed.split(":")[1]?.trim()) || 0;
        else if (trimmed.startsWith("Product Area:")) productArea = trimmed.split(":").slice(1).join(":").trim();
        else if (trimmed.startsWith("Requested By:")) requestedBy = trimmed.split(":").slice(1).join(":").trim();
        else if (trimmed.startsWith("Status:")) status = trimmed.split(":").slice(1).join(":").trim();
      }

      return {
        number: r.number,
        title: r.short_description,
        description: desc.split("\n\nProduct Area:")[0]?.trim(),
        requested_by: requestedBy || snow.displayValue(r.company),
        product_area: productArea,
        votes,
        status,
      };
    });

    // Sort by votes descending
    enhancements.sort((a: any, b: any) => b.votes - a.votes);
    return { enhancements, total: enhancements.length };
  },
});

// ---------------------------------------------------------------------------
// Write tools (snow:write)
// ---------------------------------------------------------------------------

registerTool({
  name: "create_incident",
  description: "Create a new ServiceNow incident.",
  requiredScope: "snow:write",
  operation: "write",
  inputSchema: z.object({
    short_description: z.string().describe("Brief incident summary"),
    description: z.string().describe("Detailed description"),
    priority: z.string().optional().describe("Priority: 'P1', 'P2', 'P3' (default: P3)"),
    company: z.string().optional().describe("Customer/company name"),
  }),
  async handler({ short_description, description, priority, company }) {
    const p = (priority || "P3").toUpperCase().replace("P", "");
    const sysId = await snow.createRecord("incident", {
      short_description,
      description,
      priority: p,
      company: company || "",
    });
    return { sys_id: sysId, message: `Created incident: ${short_description}` };
  },
});

registerTool({
  name: "update_incident",
  description: "Update an existing ServiceNow incident (state, priority, assigned_to, or add notes).",
  requiredScope: "snow:write",
  operation: "write",
  inputSchema: z.object({
    incident_number: z.string().describe("Incident number (e.g. INC-4521)"),
    state: z.string().optional().describe("New state: 'Open', 'In Progress', 'Resolved', 'Closed'"),
    priority: z.string().optional().describe("New priority: 'P1', 'P2', 'P3'"),
    work_notes: z.string().optional().describe("Work note to add"),
  }),
  async handler({ incident_number, state, priority, work_notes }) {
    const records = await snow.queryTable(
      "incident",
      `number=${incident_number.toUpperCase()}`,
      ["sys_id", "number"],
      1
    );
    if (!records.length) return { error: `Incident not found: ${incident_number}` };

    const stateMap: Record<string, string> = {
      Open: "1", "In Progress": "2", "On Hold": "3", Resolved: "6", Closed: "7",
    };

    const updates: Record<string, any> = {};
    if (state && stateMap[state]) updates.state = stateMap[state];
    if (priority) updates.priority = priority.toUpperCase().replace("P", "");
    if (work_notes) updates.work_notes = work_notes;

    await snow.updateRecord("incident", records[0].sys_id, updates);
    return { number: incident_number, message: `Updated incident ${incident_number}` };
  },
});

registerTool({
  name: "add_work_note",
  description: "Add a work note to a ServiceNow incident.",
  requiredScope: "snow:write",
  operation: "write",
  inputSchema: z.object({
    incident_number: z.string().describe("Incident number (e.g. INC-4521)"),
    note: z.string().describe("Work note text"),
  }),
  async handler({ incident_number, note }) {
    const records = await snow.queryTable(
      "incident",
      `number=${incident_number.toUpperCase()}`,
      ["sys_id"],
      1
    );
    if (!records.length) return { error: `Incident not found: ${incident_number}` };

    await snow.updateRecord("incident", records[0].sys_id, { work_notes: note });
    return { number: incident_number, message: `Added work note to ${incident_number}` };
  },
});
