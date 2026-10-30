// Minimal BigQuery client over the REST API. Authenticates with the token from
// the gcloud CLI, so no npm packages or key files are needed.

'use strict';

const { exec } = require('child_process');

const API_BASE = process.env.BQ_API_BASE || 'https://bigquery.googleapis.com/bigquery/v2';
const MAX_BYTES_BILLED = String(process.env.MAX_BYTES_BILLED || 10 * 1024 ** 3); // 10 GB safety cap
const DEFAULT_DATASET = { projectId: 'bigquery-public-data', datasetId: 'thelook_ecommerce' };

let cachedToken = null;
let tokenFetchedAt = 0;

function getAccessToken(force = false) {
  if (process.env.BQ_ACCESS_TOKEN) return Promise.resolve(process.env.BQ_ACCESS_TOKEN);
  if (!force && cachedToken && Date.now() - tokenFetchedAt < 45 * 60 * 1000) {
    return Promise.resolve(cachedToken);
  }
  return new Promise((resolve, reject) => {
    exec('gcloud auth print-access-token', { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        return reject(
          new Error(
            'Could not get a Google access token. Is the Google Cloud CLI installed and have you run "gcloud auth login"? ' +
              (stderr || err.message).trim()
          )
        );
      }
      cachedToken = stdout.trim();
      tokenFetchedAt = Date.now();
      resolve(cachedToken);
    });
  });
}

function getProjectFromGcloud() {
  return new Promise((resolve) => {
    exec('gcloud config get-value project', { timeout: 15000, windowsHide: true }, (err, stdout) => {
      const v = (stdout || '').trim();
      resolve(err || !v || v === '(unset)' ? null : v);
    });
  });
}

async function apiRequest(method, path, body, retry = true) {
  const token = await getAccessToken(!retry);
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && retry && !process.env.BQ_ACCESS_TOKEN) {
    return apiRequest(method, path, body, false);
  }
  if (!res.ok) {
    const msg = json.error?.message || `BigQuery returned HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- Value conversion -------------------------------------------------------

function convertValue(field, v) {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED') {
    return v.map((item) => convertValue({ ...field, mode: 'NULLABLE' }, item.v));
  }
  switch (field.type) {
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return Number(v);
    case 'BOOLEAN':
    case 'BOOL':
      return v === 'true';
    case 'TIMESTAMP': {
      // With useInt64Timestamp the value is microseconds since epoch.
      const micros = BigInt(v);
      return new Date(Number(micros / 1000n)).toISOString().replace('.000Z', 'Z');
    }
    case 'RECORD':
    case 'STRUCT': {
      const obj = {};
      field.fields.forEach((sub, i) => {
        obj[sub.name] = convertValue(sub, v.f[i].v);
      });
      return obj;
    }
    default:
      return v; // STRING, DATE, DATETIME, TIME, BYTES, GEOGRAPHY, JSON …
  }
}

function convertRows(schema, rows) {
  const fields = schema?.fields || [];
  return (rows || []).map((r) => fields.map((f, i) => convertValue(f, r.f[i].v)));
}

// ---- Queries ----------------------------------------------------------------

async function dryRun(projectId, sql) {
  const json = await apiRequest('POST', `/projects/${encodeURIComponent(projectId)}/queries`, {
    query: sql,
    useLegacySql: false,
    dryRun: true,
    defaultDataset: DEFAULT_DATASET,
  });
  return { bytesProcessed: Number(json.totalBytesProcessed || 0) };
}

/**
 * Runs a query and returns up to maxRows rows.
 * Returns { columns, types, rows, totalRows, bytesProcessed, cacheHit, ms }.
 */
async function runQuery(projectId, sql, { maxRows = 200 } = {}) {
  const started = Date.now();
  const pageSize = Math.min(maxRows, 10000);
  let json = await apiRequest('POST', `/projects/${encodeURIComponent(projectId)}/queries`, {
    query: sql,
    useLegacySql: false,
    maxResults: pageSize,
    timeoutMs: 60000,
    maximumBytesBilled: MAX_BYTES_BILLED,
    defaultDataset: DEFAULT_DATASET,
    formatOptions: { useInt64Timestamp: true },
  });

  const jobId = json.jobReference?.jobId;
  const location = json.jobReference?.location;
  const resultsPath = (extra) =>
    `/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}?` +
    new URLSearchParams({
      maxResults: String(pageSize),
      timeoutMs: '60000',
      'formatOptions.useInt64Timestamp': 'true',
      ...(location ? { location } : {}),
      ...extra,
    });

  // Poll until the job is done (long queries).
  let polls = 0;
  while (!json.jobComplete) {
    if (++polls > 10) throw new Error('The query took too long. Try narrowing it down.');
    json = await apiRequest('GET', resultsPath({}));
  }

  const schema = json.schema;
  let rows = convertRows(schema, json.rows);
  const totalRows = Number(json.totalRows || rows.length);

  // Fetch more pages if needed (only for grading, where maxRows is larger).
  let pageToken = json.pageToken;
  while (pageToken && rows.length < maxRows) {
    const page = await apiRequest('GET', resultsPath({ pageToken }));
    rows = rows.concat(convertRows(schema, page.rows));
    pageToken = page.pageToken;
  }

  return {
    columns: (schema?.fields || []).map((f) => f.name),
    types: (schema?.fields || []).map((f) => (f.mode === 'REPEATED' ? `ARRAY<${f.type}>` : f.type)),
    rows: rows.slice(0, maxRows),
    totalRows,
    bytesProcessed: Number(json.totalBytesProcessed || 0),
    cacheHit: !!json.cacheHit,
    ms: Date.now() - started,
  };
}

module.exports = { runQuery, dryRun, getAccessToken, getProjectFromGcloud };
