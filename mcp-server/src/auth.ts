/**
 * Token parsing and scope extraction.
 *
 * For the adapter path (third-party), scopes come from the Okta token.
 * For the Bedrock path (first-party), a service API key grants all scopes.
 */

import type { Scope } from "./types.js";

const ALL_SCOPES: Scope[] = ["sfdc:read", "sfdc:write", "snow:read", "snow:write"];

/**
 * Extract scopes from an Authorization header.
 *
 * Supports:
 *   - Bearer <JWT> — decodes and reads the "scp" or "scope" claim
 *   - ApiKey <key> — validates against SERVICE_API_KEY env var, grants all scopes
 *   - No header — returns all scopes (stdio mode, for local Claude Code)
 */
export function extractScopes(authHeader?: string): Scope[] {
  if (!authHeader) {
    // No auth = stdio mode (local Claude Code), grant all scopes
    return [...ALL_SCOPES];
  }

  // Service API key (for Bedrock Lambda)
  if (authHeader.startsWith("ApiKey ")) {
    const key = authHeader.slice(7);
    const expectedKey = process.env.SERVICE_API_KEY;
    if (expectedKey && key === expectedKey) {
      return [...ALL_SCOPES];
    }
    return [];
  }

  // Bearer JWT (from Okta MCP Adapter)
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      // Decode JWT payload (we trust the adapter verified the signature)
      const parts = token.split(".");
      if (parts.length !== 3) return [];
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString()
      );

      // Okta puts scopes in "scp" (array) or "scope" (space-separated string)
      let scopes: string[] = [];
      if (Array.isArray(payload.scp)) {
        scopes = payload.scp;
      } else if (typeof payload.scope === "string") {
        scopes = payload.scope.split(" ");
      }

      return scopes.filter((s): s is Scope =>
        ALL_SCOPES.includes(s as Scope)
      );
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Extract user email from a Bearer JWT token.
 * Reads the "email" or "preferred_username" or "sub" claim.
 */
export function extractUserEmail(authHeader?: string): string | undefined {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return undefined;

  const token = authHeader.slice(7);
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString()
    );
    return payload.email || payload.preferred_username || payload.sub;
  } catch {
    return undefined;
  }
}
