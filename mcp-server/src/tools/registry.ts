/**
 * Tool registry — central catalog of all tools with scope-based filtering.
 *
 * Each tool declares a requiredScope. The registry filters tools based on
 * the scopes present in the authenticated user's token:
 *   - tools/list returns only tools the user is entitled to
 *   - tools/call validates scope before executing (defense in depth)
 */

import type { Scope, ToolDefinition } from "../types.js";

const ALL_TOOLS: ToolDefinition[] = [];

/** Register a tool in the global catalog */
export function registerTool(tool: ToolDefinition): void {
  ALL_TOOLS.push(tool);
}

/** Get tools visible to a user with the given scopes */
export function listTools(scopes: Scope[]): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => scopes.includes(tool.requiredScope));
}

/** Find a tool by name, validating scope access */
export function getTool(
  name: string,
  scopes: Scope[]
): ToolDefinition | undefined {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) return undefined;
  if (!scopes.includes(tool.requiredScope)) return undefined;
  return tool;
}

/** Get all registered tools (for service-account / bypass mode) */
export function getAllTools(): ToolDefinition[] {
  return [...ALL_TOOLS];
}
