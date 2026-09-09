/**
 * Minimal MCP tool contract for this server.
 *
 * `ctx.subject` is the VERIFIED caller identity (from the bearer token). It is
 * passed to handlers by the server — it is NEVER read from `args`. Tools must
 * treat `args` as untrusted LLM output.
 */

export interface ToolContext {
  subject: string;
  email?: string;
  login?: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
