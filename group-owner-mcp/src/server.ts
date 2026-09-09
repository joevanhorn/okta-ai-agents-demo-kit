/**
 * Minimal HTTP MCP server (JSON-RPC 2.0 over POST /mcp).
 *
 * Every tool call resolves the caller identity from the bearer token FIRST
 * (Layer 1). No identity → the call is rejected before any tool runs. The
 * resolved subject is passed to handlers as context — never taken from args.
 */

import express from 'express';
import { config, assertBaselineConfig } from './config.js';
import { resolveCallerIdentity, bearerFromHeader } from './identity.js';
import { tools, toolsByName } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, fgaEnabled: config.fga.enabled, tools: tools.map((t) => t.name) });
});

app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body ?? {};
  const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) =>
    res.json({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return reply({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'group-owner-mcp', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return reply({
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === 'tools/call') {
    // LAYER 1 — identity from the verified bearer token, per call.
    const identity = await resolveCallerIdentity(bearerFromHeader(req.headers.authorization));
    if (!identity) return fail(-32001, 'Unauthorized: missing or invalid caller identity');

    const tool = toolsByName.get(params?.name);
    if (!tool) return fail(-32601, `Unknown tool: ${params?.name}`);

    const ctx: ToolContext = { subject: identity.subject, email: identity.email, login: identity.login };
    try {
      const result = await tool.handler(params?.arguments ?? {}, ctx);
      return reply(result);
    } catch (err) {
      return fail(-32603, err instanceof Error ? err.message : 'Tool execution failed');
    }
  }

  return fail(-32601, `Unknown method: ${method}`);
});

export function start(): void {
  assertBaselineConfig();
  app.listen(config.server.port, () => {
    console.log(
      `[group-owner-mcp] listening on :${config.server.port} ` +
        `(enforcement=${config.fga.enabled ? 'FGA (Layer 3)' : 'Okta ownership (Layer 2)'})`
    );
  });
}

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  start();
}
