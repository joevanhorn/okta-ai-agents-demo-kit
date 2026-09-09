/**
 * Okta FGA (Fine-Grained Authorization) client for runtime checks.
 *
 * Provides per-tool invocation checks and per-record filtering.
 * Falls back to allowing access if FGA is not configured (graceful degradation).
 */

const FGA_API_URL = process.env.FGA_API_URL || "https://api.us1.fga.dev";
const FGA_STORE_ID = process.env.FGA_STORE_ID || "";
const FGA_MODEL_ID = process.env.FGA_MODEL_ID || "";
const FGA_CLIENT_ID = process.env.FGA_CLIENT_ID || "";
const FGA_CLIENT_SECRET = process.env.FGA_CLIENT_SECRET || "";
const FGA_ENABLED = process.env.FGA_ENABLED !== "false"; // enabled by default

let accessToken: string | null = null;
let tokenExpiry = 0;

/** Authenticate to FGA API via client credentials */
async function authenticate(): Promise<void> {
  const resp = await fetch("https://auth.fga.dev/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: FGA_CLIENT_ID,
      client_secret: FGA_CLIENT_SECRET,
      audience: "https://api.us1.fga.dev/",
      grant_type: "client_credentials",
    }),
  });

  if (!resp.ok) {
    throw new Error(`FGA auth failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
}

async function getToken(): Promise<string> {
  if (!accessToken || Date.now() > tokenExpiry) {
    await authenticate();
  }
  return accessToken!;
}

/** Run a single FGA check */
export async function check(
  user: string,
  relation: string,
  object: string
): Promise<boolean> {
  if (!FGA_ENABLED) return true;

  try {
    const token = await getToken();
    const resp = await fetch(
      `${FGA_API_URL}/stores/${FGA_STORE_ID}/check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          authorization_model_id: FGA_MODEL_ID,
          tuple_key: { user, relation, object },
        }),
      }
    );

    if (!resp.ok) {
      console.error(`FGA check failed (${resp.status}): ${await resp.text()}`);
      return true; // fail open for demo
    }

    const data = await resp.json();
    return data.allowed === true;
  } catch (err) {
    console.error(`FGA check error: ${err}`);
    return true; // fail open
  }
}

/** Check if a user can invoke a tool (read or write) */
export async function canInvokeTool(
  userEmail: string,
  toolName: string,
  isWrite: boolean
): Promise<boolean> {
  const fgaUser = `user:${userEmail}`;
  const fgaObject = `tool:${toolName}`;
  const relation = isWrite ? "can_invoke_write" : "can_invoke_read";

  const allowed = await check(fgaUser, relation, fgaObject);
  if (!allowed) {
    console.log(`FGA DENIED: ${fgaUser} -> ${relation} -> ${fgaObject}`);
  }
  return allowed;
}

/** Check if a user can view a Salesforce account */
export async function canViewAccount(
  userEmail: string,
  accountName: string
): Promise<boolean> {
  const fgaUser = `user:${userEmail}`;
  const slug = accountName.toLowerCase().replace(/\s+/g, "-");
  return check(fgaUser, "viewer", `sfdc_account:${slug}`);
}

/** Check if a user can edit a Salesforce account */
export async function canEditAccount(
  userEmail: string,
  accountName: string
): Promise<boolean> {
  const fgaUser = `user:${userEmail}`;
  const slug = accountName.toLowerCase().replace(/\s+/g, "-");
  return check(fgaUser, "editor", `sfdc_account:${slug}`);
}

/** Check if a user can view a ServiceNow incident */
export async function canViewIncident(
  userEmail: string,
  incidentNumber: string
): Promise<boolean> {
  const fgaUser = `user:${userEmail}`;
  return check(fgaUser, "viewer", `snow_incident:${incidentNumber}`);
}

/** Filter an array of records based on FGA viewer checks */
export async function filterByAccess<T>(
  userEmail: string,
  records: T[],
  getObjectId: (record: T) => string,
  objectType: string,
  relation: string = "viewer"
): Promise<T[]> {
  if (!FGA_ENABLED || !userEmail) return records;

  const fgaUser = `user:${userEmail}`;
  const results = await Promise.all(
    records.map(async (record) => {
      const objectId = getObjectId(record);
      const slug = objectId.toLowerCase().replace(/\s+/g, "-");
      const allowed = await check(fgaUser, relation, `${objectType}:${slug}`);
      return { record, allowed };
    })
  );

  const filtered = results.filter((r) => r.allowed).map((r) => r.record);
  if (filtered.length < records.length) {
    console.log(
      `FGA filtered ${records.length - filtered.length}/${records.length} ` +
      `${objectType} records for ${userEmail}`
    );
  }
  return filtered;
}
