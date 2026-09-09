/**
 * Shared types for the MCP server.
 */

import { z } from "zod";

/** Scopes that control tool visibility */
export type Scope =
  | "sfdc:read"
  | "sfdc:write"
  | "snow:read"
  | "snow:write";

/** Context passed to every tool handler */
export interface RequestContext {
  /** Scopes from the authenticated user's token */
  scopes: Scope[];
  /** User identifier (email or sub claim) */
  userId?: string;
}

/** Whether a tool performs read or write operations */
export type ToolOperation = "read" | "write";

/** A tool definition with scope metadata */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  requiredScope: Scope;
  operation: ToolOperation;
  handler: (args: any, context: RequestContext) => Promise<any>;
}
