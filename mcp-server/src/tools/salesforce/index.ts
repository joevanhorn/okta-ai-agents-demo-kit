/**
 * Salesforce MCP tools — registered with scope metadata.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import * as sfdc from "./client.js";

// ---------------------------------------------------------------------------
// Read tools (sfdc:read)
// ---------------------------------------------------------------------------

registerTool({
  name: "search_accounts",
  description: "Search Salesforce accounts by name. Returns account ID, name, industry, type, revenue, and description.",
  requiredScope: "sfdc:read",
  operation: "read",
  inputSchema: z.object({
    query: z.string().describe("Account name or keyword to search for"),
  }),
  async handler({ query }) {
    const escaped = query.replace(/'/g, "\\'");
    const records = await sfdc.query(
      `SELECT Id, Name, Industry, Type, AnnualRevenue, NumberOfEmployees, ` +
      `BillingCity, BillingStateCode, Description ` +
      `FROM Account WHERE Name LIKE '%${escaped}%' LIMIT 10`
    );
    return {
      accounts: records.map((r: any) => ({
        id: r.Id,
        name: r.Name,
        industry: r.Industry,
        type: r.Type,
        annualRevenue: r.AnnualRevenue,
        employees: r.NumberOfEmployees,
        city: r.BillingCity,
        state: r.BillingStateCode,
        description: r.Description,
      })),
      total: records.length,
    };
  },
});

registerTool({
  name: "get_account_details",
  description: "Get full details for a Salesforce account including related opportunities and contacts. Pass the account ID or name.",
  requiredScope: "sfdc:read",
  operation: "read",
  inputSchema: z.object({
    account_id: z.string().describe("Salesforce Account ID (starts with 001) or account name"),
  }),
  async handler({ account_id }) {
    // Find by ID or name
    let accounts: any[];
    if (account_id.startsWith("001")) {
      accounts = await sfdc.query(
        `SELECT Id, Name, Industry, Type, AnnualRevenue, NumberOfEmployees, ` +
        `BillingCity, BillingStateCode, Description ` +
        `FROM Account WHERE Id = '${account_id}' LIMIT 1`
      );
    } else {
      const escaped = account_id.replace(/'/g, "\\'");
      accounts = await sfdc.query(
        `SELECT Id, Name, Industry, Type, AnnualRevenue, NumberOfEmployees, ` +
        `BillingCity, BillingStateCode, Description ` +
        `FROM Account WHERE Name LIKE '%${escaped}%' LIMIT 1`
      );
    }

    if (!accounts.length) return { error: `Account not found: ${account_id}` };
    const account = accounts[0];

    // Get related opportunities
    const opps = await sfdc.query(
      `SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, Description, NextStep ` +
      `FROM Opportunity WHERE AccountId = '${account.Id}'`
    );

    // Get related contacts
    const contacts = await sfdc.query(
      `SELECT Id, Name, Title, Email, Phone FROM Contact WHERE AccountId = '${account.Id}'`
    );

    return {
      id: account.Id,
      name: account.Name,
      industry: account.Industry,
      type: account.Type,
      annualRevenue: account.AnnualRevenue,
      employees: account.NumberOfEmployees,
      city: account.BillingCity,
      state: account.BillingStateCode,
      description: account.Description,
      opportunities: opps.map((o: any) => ({
        name: o.Name,
        stage: o.StageName,
        amount: o.Amount,
        closeDate: o.CloseDate,
        probability: o.Probability,
        type: o.Type,
        nextStep: o.NextStep,
        description: o.Description,
      })),
      contacts: contacts.map((c: any) => ({
        name: c.Name,
        title: c.Title,
        email: c.Email,
      })),
    };
  },
});

registerTool({
  name: "search_opportunities",
  description: "Search Salesforce opportunities by name, account, or stage.",
  requiredScope: "sfdc:read",
  operation: "read",
  inputSchema: z.object({
    query: z.string().describe("Opportunity name, account name, or stage to search for"),
  }),
  async handler({ query }) {
    const escaped = query.replace(/'/g, "\\'");
    const records = await sfdc.query(
      `SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, ` +
      `Account.Name, Description, NextStep ` +
      `FROM Opportunity WHERE Name LIKE '%${escaped}%' ` +
      `OR Account.Name LIKE '%${escaped}%' ` +
      `OR StageName LIKE '%${escaped}%' LIMIT 20`
    );
    return {
      opportunities: records.map((r: any) => ({
        id: r.Id,
        name: r.Name,
        account: r.Account?.Name,
        stage: r.StageName,
        amount: r.Amount,
        closeDate: r.CloseDate,
        probability: r.Probability,
        type: r.Type,
        nextStep: r.NextStep,
        description: r.Description,
      })),
      total: records.length,
    };
  },
});

registerTool({
  name: "list_contacts",
  description: "List contacts for a Salesforce account.",
  requiredScope: "sfdc:read",
  operation: "read",
  inputSchema: z.object({
    account_name: z.string().describe("Account name to list contacts for"),
  }),
  async handler({ account_name }) {
    const escaped = account_name.replace(/'/g, "\\'");
    const records = await sfdc.query(
      `SELECT Id, Name, Title, Email, Phone, Account.Name ` +
      `FROM Contact WHERE Account.Name LIKE '%${escaped}%' LIMIT 20`
    );
    return {
      contacts: records.map((r: any) => ({
        name: r.Name,
        title: r.Title,
        email: r.Email,
        phone: r.Phone,
        account: r.Account?.Name,
      })),
      total: records.length,
    };
  },
});

// ---------------------------------------------------------------------------
// Write tools (sfdc:write)
// ---------------------------------------------------------------------------

registerTool({
  name: "create_opportunity",
  description: "Create a new Salesforce opportunity linked to an account.",
  requiredScope: "sfdc:write",
  operation: "write",
  inputSchema: z.object({
    name: z.string().describe("Opportunity name"),
    account_name: z.string().describe("Account name to link to"),
    stage: z.string().describe("Stage name (e.g. 'Prospecting', 'Qualification')"),
    amount: z.number().describe("Deal amount in dollars"),
    close_date: z.string().describe("Expected close date (YYYY-MM-DD)"),
  }),
  async handler({ name, account_name, stage, amount, close_date }) {
    const escaped = account_name.replace(/'/g, "\\'");
    const accounts = await sfdc.query(
      `SELECT Id FROM Account WHERE Name LIKE '%${escaped}%' LIMIT 1`
    );
    if (!accounts.length) return { error: `Account not found: ${account_name}` };

    const id = await sfdc.create("Opportunity", {
      Name: name,
      AccountId: accounts[0].Id,
      StageName: stage,
      Amount: amount,
      CloseDate: close_date,
    });
    return { id, message: `Created opportunity: ${name}` };
  },
});

registerTool({
  name: "update_opportunity",
  description: "Update an existing Salesforce opportunity (stage, amount, close date, or next step).",
  requiredScope: "sfdc:write",
  operation: "write",
  inputSchema: z.object({
    opportunity_name: z.string().describe("Opportunity name to find and update"),
    stage: z.string().optional().describe("New stage name"),
    amount: z.number().optional().describe("New deal amount"),
    close_date: z.string().optional().describe("New close date (YYYY-MM-DD)"),
    next_step: z.string().optional().describe("Next step note"),
  }),
  async handler({ opportunity_name, stage, amount, close_date, next_step }) {
    const escaped = opportunity_name.replace(/'/g, "\\'");
    const opps = await sfdc.query(
      `SELECT Id, Name FROM Opportunity WHERE Name LIKE '%${escaped}%' LIMIT 1`
    );
    if (!opps.length) return { error: `Opportunity not found: ${opportunity_name}` };

    const updates: Record<string, any> = {};
    if (stage) updates.StageName = stage;
    if (amount) updates.Amount = amount;
    if (close_date) updates.CloseDate = close_date;
    if (next_step) updates.NextStep = next_step;

    await sfdc.update("Opportunity", opps[0].Id, updates);
    return { id: opps[0].Id, message: `Updated opportunity: ${opps[0].Name}` };
  },
});

registerTool({
  name: "log_activity",
  description: "Log an activity (task) against a Salesforce account or contact.",
  requiredScope: "sfdc:write",
  operation: "write",
  inputSchema: z.object({
    subject: z.string().describe("Activity subject"),
    description: z.string().describe("Activity description/notes"),
    account_name: z.string().describe("Account name to log against"),
    status: z.string().optional().describe("Task status (default: Completed)"),
  }),
  async handler({ subject, description, account_name, status }) {
    const escaped = account_name.replace(/'/g, "\\'");
    const accounts = await sfdc.query(
      `SELECT Id FROM Account WHERE Name LIKE '%${escaped}%' LIMIT 1`
    );
    if (!accounts.length) return { error: `Account not found: ${account_name}` };

    const id = await sfdc.create("Task", {
      Subject: subject,
      Description: description,
      WhatId: accounts[0].Id,
      Status: status || "Completed",
    });
    return { id, message: `Logged activity: ${subject}` };
  },
});
