// Google Search Console access from a Worker via a service-account JWT.
// Requires env.GSC_SA_KEY = the whole service-account JSON key (as a string).
// The service account must be added as a user on each Search Console property.

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = (s) => b64url(new TextEncoder().encode(s));

function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

// Exchange the service-account key for a short-lived OAuth access token.
export async function getAccessToken(sa, nowSec) {
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`GSC token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Search Analytics rows for one property over [start, end] (YYYY-MM-DD).
// pageFilter is an optional RE2 expression matched against the result page URL.
async function querySearchAnalytics(token, siteUrl, start, end, dimension, rowLimit, pageFilter) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const requestBody = { startDate: start, endDate: end };
  if (dimension) requestBody.dimensions = [dimension];
  if (rowLimit) requestBody.rowLimit = rowLimit;
  if (pageFilter) {
    requestBody.dimensionFilterGroups = [{
      groupType: "and",
      filters: [{ dimension: "page", operator: "includingRegex", expression: pageFilter }],
    }];
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) throw new Error(`GSC ${dimension} ${res.status} for ${siteUrl}: ${await res.text()}`);
  const body = await res.json();
  return body.rows ?? [];
}

// Aggregate totals for the window. Keeping this separate from ranked
// query/page rows avoids under-counting when Search Console truncates those lists.
export async function querySearchSummary(token, siteUrl, start, end, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, null, 1, pageFilter);
  const row = rows[0] ?? {};
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
}

export async function queryKeywords(token, siteUrl, start, end, rowLimit = 25, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, "query", rowLimit, pageFilter);
  return rows.map((r) => ({
    query: r.keys[0],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export async function queryPages(token, siteUrl, start, end, rowLimit = 25, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, "page", rowLimit, pageFilter);
  return rows.map((r) => ({
    page: r.keys[0],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}
