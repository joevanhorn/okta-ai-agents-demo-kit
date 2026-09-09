/**
 * MOCK MCP server for local demos — NO live Okta, NO credentials.
 *
 * Serves the REAL three group-owner tools and the REAL ownership gate over the
 * same JSON-RPC `/mcp` endpoint as the production server, but swaps the Okta
 * HTTP client for a deterministic in-memory fixture. Enforcement is Layer 2
 * (Okta ownership, FGA off) — exactly what you'd see live.
 *
 * DEMO IDENTITY: the acting user is taken verbatim from the bearer token, i.e.
 *   Authorization: Bearer 00uALICE   ->   context.subject = "00uALICE"
 * (In production the bearer is a validated Okta access token and subject = its
 * `sub`. This shortcut is DEMO-ONLY so you can switch users without minting JWTs.)
 *
 *   npx tsx scripts/mock-server.ts      # or: npm run mock
 */

import express from 'express';
import { groupsClient } from '../src/okta/groups-client.js';
import { tools, toolsByName } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

// ---------------------------------------------------------------------------
// In-memory fixture: Alice owns two groups; Executive-Comp belongs to Bob.
// ---------------------------------------------------------------------------
const ALICE = '00uALICE';
const OWNED = new Set(['00gCON', '00gPHX']);
const NAMES: Record<string, string> = {
  '00gCON': 'Contractors',
  '00gPHX': 'Project-Phoenix',
  '00gEXE': 'Executive-Comp',
};
const members: Record<string, Set<string>> = {
  '00gCON': new Set(['dana@ext.com']),
  '00gPHX': new Set(['erin@taskvantage.okta.com']),
  '00gEXE': new Set(['ceo@taskvantage.okta.com']),
};

Object.assign(groupsClient, {
  async listOwners(groupId: string) {
    return OWNED.has(groupId) ? [{ id: ALICE, type: 'USER' }] : [{ id: '00uBOB', type: 'USER' }];
  },
  async listAllGroups() {
    return Object.keys(NAMES).map((id) => ({ id, profile: { name: NAMES[id] } }));
  },
  async getById(groupId: string) {
    return { id: groupId, profile: { name: NAMES[groupId] ?? groupId } };
  },
  async listMembers(groupId: string) {
    return Array.from(members[groupId] ?? []).map((login, i) => ({ id: `00u${i}`, profile: { login } }));
  },
  async isMember(groupId: string, userId: string) {
    return members[groupId]?.has(userId) ?? false;
  },
  async addMember(groupId: string, userId: string) {
    members[groupId]?.add(userId);
  },
  async removeMember(groupId: string, userId: string) {
    members[groupId]?.delete(userId);
  },
  async getUserByIdOrLogin(idOrLogin: string) {
    return { id: idOrLogin, profile: { login: idOrLogin } };
  },
});

// ---------------------------------------------------------------------------
// HTTP JSON-RPC MCP endpoint (same shape as src/server.ts)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, mode: 'MOCK', enforcement: 'Okta ownership (Layer 2), FGA off', tools: tools.map((t) => t.name) });
});

app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body ?? {};
  const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'group-owner-mcp (MOCK)', version: '1.0.0' } });
  }
  if (method === 'tools/list') {
    return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const auth = req.headers.authorization ?? '';
    const subject = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!subject) return fail(-32001, 'Unauthorized: send Authorization: Bearer <okta-user-id>');
    const tool = toolsByName.get(params?.name);
    if (!tool) return fail(-32601, `Unknown tool: ${params?.name}`);
    const ctx: ToolContext = { subject };
    try {
      return reply(await tool.handler(params?.arguments ?? {}, ctx));
    } catch (err) {
      return fail(-32603, err instanceof Error ? err.message : 'Tool execution failed');
    }
  }
  return fail(-32601, `Unknown method: ${method}`);
});

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  console.log(`[group-owner-mcp MOCK] listening on http://localhost:${PORT}/mcp`);
  console.log('  enforcement: Okta ownership (Layer 2), FGA off');
  console.log('  fixture: 00uALICE owns Contractors (00gCON) + Project-Phoenix (00gPHX)');
  console.log('           00gEXE (Executive-Comp) is owned by 00uBOB — Alice must be DENIED on it');
});
