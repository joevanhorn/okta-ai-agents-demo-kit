/**
 * TaskVantage MCP Server — serves Salesforce and ServiceNow tools.
 *
 * Supports two transports:
 *   - stdio: For direct Claude Code usage (local development)
 *   - HTTP/SSE: For remote access through the Okta MCP Adapter or Bedrock Lambda
 *
 * Usage:
 *   npx tsx src/index.ts                  # stdio mode (default)
 *   TRANSPORT=http npx tsx src/index.ts   # HTTP mode on port 3000
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

import { extractScopes, extractUserEmail } from "./auth.js";
import { canInvokeTool, filterByAccess } from "./fga.js";
import { listTools, getTool, getAllTools } from "./tools/registry.js";
import type { Scope, RequestContext } from "./types.js";

// Import tool modules to trigger registration
import "./tools/salesforce/index.js";
import "./tools/servicenow/index.js";

const PORT = parseInt(process.env.PORT || "3000");
const TRANSPORT = process.env.TRANSPORT || "stdio";

// ---------------------------------------------------------------------------
// Create MCP Server
// ---------------------------------------------------------------------------

function createServer(scopes?: Scope[], userEmail?: string): McpServer {
  const server = new McpServer({
    name: "TaskVantage MCP Server",
    version: "1.0.0",
  });

  // Determine which tools to expose based on scopes
  const tools = scopes ? listTools(scopes) : getAllTools();

  // Register each visible tool with the MCP server
  for (const tool of tools) {
    // Pass the Zod shape (extracted from the ZodObject)
    const shape = (tool.inputSchema as any).shape as Record<string, any>;
    server.tool(tool.name, tool.description, shape, async (args) => {
      const context: RequestContext = {
        scopes: scopes || (["sfdc:read", "sfdc:write", "snow:read", "snow:write"] as Scope[]),
        userId: userEmail,
      };

      // FGA Layer 1: Can this user invoke this tool?
      if (userEmail) {
        const isWrite = tool.operation === "write";
        const allowed = await canInvokeTool(userEmail, tool.name, isWrite);
        if (!allowed) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Authorization denied",
                detail: `User ${userEmail} is not authorized to invoke ${tool.name}`,
                fga_check: { user: userEmail, tool: tool.name, operation: tool.operation },
              }),
            }],
            isError: true,
          };
        }
      }

      try {
        let result = await tool.handler(args, context);

        // FGA Layer 2: Filter results by per-record access
        if (userEmail && result) {
          // Filter Salesforce accounts
          if (result.accounts && Array.isArray(result.accounts)) {
            result.accounts = await filterByAccess(
              userEmail,
              result.accounts,
              (r: any) => r.name || r.Name || "",
              "sfdc_account"
            );
            result.total = result.accounts.length;
          }
          // Filter Salesforce opportunities (by account)
          if (result.opportunities && Array.isArray(result.opportunities)) {
            result.opportunities = await filterByAccess(
              userEmail,
              result.opportunities,
              (r: any) => r.account || r.Account?.Name || "",
              "sfdc_account"
            );
            result.total = result.opportunities.length;
          }
          // Filter ServiceNow incidents
          if (result.incidents && Array.isArray(result.incidents)) {
            result.incidents = await filterByAccess(
              userEmail,
              result.incidents,
              (r: any) => r.number || "",
              "snow_incident"
            );
            result.total = result.incidents.length;
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// stdio transport (for Claude Code direct)
// ---------------------------------------------------------------------------

async function runStdio(): Promise<void> {
  console.error("Starting MCP server (stdio transport)...");
  console.error(`Registered tools: ${getAllTools().map((t) => t.name).join(", ")}`);

  const server = createServer(); // All scopes in stdio mode
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server connected via stdio");
}

// ---------------------------------------------------------------------------
// HTTP/SSE transport (for adapter / Bedrock)
// ---------------------------------------------------------------------------

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", tools: getAllTools().length });
  });

  // JSON-RPC endpoint (POST /mcp) — for the Okta MCP Adapter
  // The adapter POSTs standard MCP JSON-RPC messages and expects JSON responses.
  app.post("/mcp", async (req, res) => {
    const scopes = extractScopes(req.headers.authorization);
    const userEmail = extractUserEmail(req.headers.authorization) || (req.headers["x-user-email"] as string);
    const body = req.body;

    if (!body || !body.method) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: body?.id || null });
      return;
    }

    const method = body.method;
    const id = body.id;

    if (method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "TaskVantage MCP Server", version: "1.0.0" },
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      res.json({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      const tools = scopes.length > 0 ? listTools(scopes) : getAllTools();
      const toolList = tools.map((t) => {
        // Convert Zod schema to JSON Schema format
        const properties: Record<string, any> = {};
        const required: string[] = [];
        if (t.inputSchema && "shape" in t.inputSchema) {
          const shape = (t.inputSchema as any).shape;
          for (const [key, val] of Object.entries(shape)) {
            const field = val as any;
            const prop: any = { type: "string" };
            if (field.description) prop.description = field.description;
            properties[key] = prop;
            // Check if required (not optional)
            if (!field.isOptional || !field.isOptional()) {
              required.push(key);
            }
          }
        }
        return {
          name: t.name,
          description: t.description,
          inputSchema: {
            type: "object",
            properties,
            ...(required.length > 0 ? { required } : {}),
          },
        };
      });
      res.json({ jsonrpc: "2.0", id, result: { tools: toolList } });
      return;
    }

    if (method === "tools/call") {
      const toolName = body.params?.name;
      const args = body.params?.arguments || {};
      // Use all scopes if none extracted (adapter handles auth, we trust it)
      const effectiveScopes = scopes.length > 0 ? scopes : (["sfdc:read", "sfdc:write", "snow:read", "snow:write"] as Scope[]);
      const tool = getTool(toolName, effectiveScopes);
      if (!tool) {
        const allTool = getAllTools().find((t) => t.name === toolName);
        if (!allTool) {
          res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool not found: ${toolName}` } });
        } else {
          res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: `Not authorized for tool: ${toolName}` } });
        }
        return;
      }

      // FGA check
      if (userEmail) {
        const isWrite = tool.operation === "write";
        const allowed = await canInvokeTool(userEmail, tool.name, isWrite);
        if (!allowed) {
          res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: "FGA denied", tool: toolName }) }], isError: true } });
          return;
        }
      }

      try {
        const result = await tool.handler(args, { scopes, userId: userEmail });
        res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (err: any) {
        res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true } });
      }
      return;
    }

    if (method === "ping") {
      res.json({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  });

  // SSE endpoint for MCP (legacy)
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const scopes = extractScopes(req.headers.authorization);
    const userEmail = extractUserEmail(req.headers.authorization) || (req.headers["x-user-email"] as string);
    console.log(`SSE connection — scopes: [${scopes.join(", ")}], user: ${userEmail || "anonymous"}`);

    const server = createServer(scopes, userEmail);
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  // Simple REST endpoint for Bedrock Lambda (non-MCP clients)
  app.post("/api/tool", async (req, res) => {
    const scopes = extractScopes(req.headers.authorization);
    const userEmail = (req.headers["x-user-email"] as string) || extractUserEmail(req.headers.authorization);
    const { name, args } = req.body;

    const tool = getTool(name, scopes);
    if (!tool) {
      res.status(403).json({ error: `Tool not available: ${name}` });
      return;
    }

    // FGA check on REST endpoint
    if (userEmail) {
      const allowed = await canInvokeTool(userEmail, name, tool.operation === "write");
      if (!allowed) {
        res.status(403).json({
          error: "Authorization denied by FGA",
          detail: `User ${userEmail} cannot invoke ${name}`,
        });
        return;
      }
    }

    try {
      const result = await tool.handler(args, { scopes, userId: userEmail });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`MCP server (HTTP) listening on port ${PORT}`);
    console.log(`Registered tools: ${getAllTools().map((t) => t.name).join(", ")}`);
    console.log(`Endpoints: GET /sse, POST /messages, POST /api/tool, GET /health`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (TRANSPORT === "http") {
  runHttp();
} else {
  runStdio();
}
