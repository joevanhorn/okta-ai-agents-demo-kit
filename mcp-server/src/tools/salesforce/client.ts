/**
 * Salesforce REST API client — authenticates via OAuth client credentials.
 * Credentials come from environment variables (populated from Secrets Manager).
 */

let accessToken: string | null = null;
let instanceUrl: string = process.env.SFDC_INSTANCE_URL || "";
const API_VERSION = "v60.0";

async function authenticate(): Promise<void> {
  const clientId = process.env.SFDC_CLIENT_ID;
  const clientSecret = process.env.SFDC_CLIENT_SECRET;
  const url = process.env.SFDC_INSTANCE_URL;

  if (!clientId || !clientSecret || !url) {
    throw new Error("Salesforce credentials not configured (SFDC_CLIENT_ID, SFDC_CLIENT_SECRET, SFDC_INSTANCE_URL)");
  }

  const resp = await fetch(`${url}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Salesforce auth failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json();
  accessToken = data.access_token;
  if (data.instance_url) instanceUrl = data.instance_url;
}

/** Execute a SOQL query */
export async function query(soql: string): Promise<any[]> {
  if (!accessToken) await authenticate();

  let resp = await fetch(
    `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
  );

  // Re-auth on 401
  if (resp.status === 401) {
    await authenticate();
    resp = await fetch(
      `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
  }

  if (!resp.ok) throw new Error(`SOQL failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return data.records || [];
}

/** Create a record */
export async function create(sobject: string, data: Record<string, any>): Promise<string> {
  if (!accessToken) await authenticate();

  const resp = await fetch(
    `${instanceUrl}/services/data/${API_VERSION}/sobjects/${sobject}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );

  if (!resp.ok) throw new Error(`Create ${sobject} failed (${resp.status}): ${await resp.text()}`);
  const result = await resp.json();
  return result.id;
}

/** Update a record */
export async function update(sobject: string, id: string, data: Record<string, any>): Promise<void> {
  if (!accessToken) await authenticate();

  const resp = await fetch(
    `${instanceUrl}/services/data/${API_VERSION}/sobjects/${sobject}/${id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );

  if (!resp.ok) throw new Error(`Update ${sobject}/${id} failed (${resp.status}): ${await resp.text()}`);
}
