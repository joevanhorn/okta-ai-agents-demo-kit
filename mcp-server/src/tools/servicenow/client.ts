/**
 * ServiceNow REST API client — authenticates via basic auth.
 * Credentials come from environment variables (populated from Secrets Manager).
 */

const instanceUrl = process.env.SNOW_INSTANCE_URL || "";
const username = process.env.SNOW_USERNAME || "";
const password = process.env.SNOW_PASSWORD || "";

function authHeader(): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

/** Query a ServiceNow table */
export async function queryTable(
  table: string,
  query?: string,
  fields?: string[],
  limit = 20
): Promise<any[]> {
  const params = new URLSearchParams({
    sysparm_limit: String(limit),
    sysparm_display_value: "true",
  });
  if (query) params.set("sysparm_query", query);
  if (fields) params.set("sysparm_fields", fields.join(","));

  const resp = await fetch(`${instanceUrl}/api/now/table/${table}?${params}`, {
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
    },
  });

  if (!resp.ok) throw new Error(`ServiceNow query failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return data.result || [];
}

/** Create a record */
export async function createRecord(
  table: string,
  data: Record<string, any>
): Promise<string> {
  const resp = await fetch(`${instanceUrl}/api/now/table/${table}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) throw new Error(`Create ${table} failed (${resp.status}): ${await resp.text()}`);
  const result = await resp.json();
  return result.result.sys_id;
}

/** Update a record */
export async function updateRecord(
  table: string,
  sysId: string,
  data: Record<string, any>
): Promise<void> {
  const resp = await fetch(`${instanceUrl}/api/now/table/${table}/${sysId}`, {
    method: "PATCH",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) throw new Error(`Update ${table}/${sysId} failed (${resp.status}): ${await resp.text()}`);
}

/** Helper to extract display value from a field (handles both string and object formats) */
export function displayValue(field: any): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  if (typeof field === "object" && "display_value" in field) return field.display_value;
  return String(field);
}
