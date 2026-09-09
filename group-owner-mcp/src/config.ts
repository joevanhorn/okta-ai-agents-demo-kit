/**
 * Central configuration, read once from the environment.
 *
 * Design note: FGA is an OPTIONAL enhancement (Layer 3). It is OFF unless
 * FGA_ENABLED is explicitly "true", which reinforces the core narrative:
 * the server fully enforces group ownership WITHOUT FGA (Layer 2).
 */

const domain = process.env.OKTA_DOMAIN ?? '';

export const config = {
  okta: {
    domain,
    issuer: process.env.OKTA_ISSUER ?? (domain ? `https://${domain}` : ''),
    apiV1: domain ? `https://${domain}/api/v1` : '',
    clientId: process.env.OKTA_CLIENT_ID ?? '',
    privateKeyPath: process.env.OKTA_PRIVATE_KEY_PATH ?? '',
    serviceScopes:
      process.env.OKTA_SERVICE_SCOPES ??
      'okta.groups.read okta.groups.manage okta.users.read',
  },

  identity: {
    // Layer 1: verify the caller's bearer token against the org JWKS.
    verifyTokens: process.env.VERIFY_TOKENS !== 'false',
  },

  fga: {
    // Explicit opt-in — baseline (Layer 2) does not depend on this.
    enabled: process.env.FGA_ENABLED === 'true',
    apiUrl: process.env.FGA_API_URL ?? 'https://api.us1.fga.dev',
    storeId: process.env.FGA_STORE_ID ?? '',
    modelId: process.env.FGA_MODEL_ID ?? '',
    clientId: process.env.FGA_CLIENT_ID ?? '',
    clientSecret: process.env.FGA_CLIENT_SECRET ?? '',
    tokenIssuer: process.env.FGA_API_TOKEN_ISSUER ?? 'https://auth.fga.dev/oauth/token',
    audience: process.env.FGA_AUDIENCE ?? 'https://api.us1.fga.dev/',
  },

  server: {
    port: Number(process.env.PORT ?? 8080),
  },
} as const;

/** Fail fast at startup if the Layer 2 essentials are missing. */
export function assertBaselineConfig(): void {
  const missing: string[] = [];
  if (!config.okta.domain) missing.push('OKTA_DOMAIN');
  if (!config.okta.clientId) missing.push('OKTA_CLIENT_ID');
  if (!config.okta.privateKeyPath) missing.push('OKTA_PRIVATE_KEY_PATH');
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required Okta service configuration: ${missing.join(', ')}`
    );
  }
}
