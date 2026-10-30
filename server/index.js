// SQL Practice — local server. Serves the web app and runs queries in BigQuery.
// Start with: node server/index.js   (or: npm start)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runQuery, dryRun, getAccessToken, getProjectFromGcloud } = require('./bigquery');
const { compareResults, checkPatterns } = require('./grader');
const { guardSql } = require('./sqlguard');

const ROOT = path.join(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXERCISE_DIR = path.join(ROOT, 'exercises');
const DISPLAY_ROWS = 200;
const GRADE_ROWS = 5000;

let projectId = process.env.GCP_PROJECT_ID || null;

// ---- Exercises ----------------------------------------------------------------

function loadCourse() {
  const files = fs.readdirSync(EXERCISE_DIR).filter((f) => /^\d+.*\.json$/.test(f)).sort();
  const modules = files.map((f) => JSON.parse(fs.readFileSync(path.join(EXERCISE_DIR, f), 'utf8')));
  const schema = JSON.parse(fs.readFileSync(path.join(EXERCISE_DIR, 'schema.json'), 'utf8'));
  const byId = new Map();
  for (const m of modules) {
    for (const e of m.exercises) {
      // Multi-line text may be written as arrays of lines in the JSON files.
      for (const key of ['context', 'starter', 'solution']) {
        if (Array.isArray(e[key])) e[key] = e[key].join('\n');
      }
      byId.set(e.id, e);
    }
  }
  return { modules, schema, byId };
}

let course = loadCourse();

// Expected results are cached per exercise and UTC day (the public dataset is refreshed regularly).
const expectedCache = new Map();
async function getExpected(exercise) {
  const key = `${exercise.id}|${new Date().toISOString().slice(0, 10)}`;
  if (!expectedCache.has(key)) {
    const p = runQuery(projectId, exercise.solution, { maxRows: GRADE_ROWS }).catch((err) => {
      expectedCache.delete(key);
      throw err;
    });
    expectedCache.set(key, p);
  }
  return expectedCache.get(key);
}

// ---- HTTP helpers -------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function friendlyError(err) {
  let msg = err.message || String(err);
  if (/bytes billed/i.test(msg)) msg += ' (This query scans too much data — add filters or select fewer columns.)';
  if (/billing/i.test(msg) && /not enabled|disabled/i.test(msg)) msg += ' (Check that the BigQuery sandbox is set up for this project.)';
  return msg;
}

// ---- API ----------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/course') {
    if (process.env.RELOAD_EXERCISES !== '0') course = loadCourse(); // edit JSON, refresh browser
    return sendJson(res, 200, { modules: course.modules, schema: course.schema });
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    if (!projectId) projectId = await getProjectFromGcloud();
    if (!projectId) {
      return sendJson(res, 200, { ok: false, error: 'No Google Cloud project set. Add GCP_PROJECT_ID to the .env file.' });
    }
    try {
      await getAccessToken();
      await dryRun(projectId, 'SELECT 1');
      return sendJson(res, 200, { ok: true, projectId });
    } catch (err) {
      return sendJson(res, 200, { ok: false, projectId, error: friendlyError(err) });
    }
  }

  if (req.method === 'POST' && (pathname === '/api/run' || pathname === '/api/submit')) {
    const body = await readBody(req);
    const sql = String(body.sql || '');
    const guard = guardSql(sql);
    if (guard) return sendJson(res, 200, { ok: false, error: guard });
    if (!projectId) projectId = await getProjectFromGcloud();
    if (!projectId) return sendJson(res, 200, { ok: false, error: 'No Google Cloud project set. Add GCP_PROJECT_ID to the .env file.' });

    let exercise = null;
    if (pathname === '/api/submit') {
      exercise = course.byId.get(body.exerciseId);
      if (!exercise) return sendJson(res, 404, { ok: false, error: 'Unknown exercise' });
    }

    let result;
    try {
      const dry = await dryRun(projectId, sql);
      result = await runQuery(projectId, sql, { maxRows: exercise ? GRADE_ROWS : DISPLAY_ROWS });
      result.bytesProcessed = result.bytesProcessed || dry.bytesProcessed;
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: friendlyError(err) });
    }

    const preview = { ...result, rows: result.rows.slice(0, DISPLAY_ROWS) };
    if (!exercise) return sendJson(res, 200, { ok: true, result: preview });

    // ---- Grading ----
    const patterns = checkPatterns(sql, exercise);
    if (!patterns.ok) return sendJson(res, 200, { ok: true, result: preview, grade: { correct: false, message: patterns.message } });

    if (result.totalRows > GRADE_ROWS) {
      return sendJson(res, 200, {
        ok: true,
        result: preview,
        grade: { correct: false, message: `Your query returns ${result.totalRows.toLocaleString('en')} rows — far more than expected. Did you forget to aggregate or filter?` },
      });
    }

    let expected;
    try {
      expected = await getExpected(exercise);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: 'Could not compute the expected answer: ' + friendlyError(err) });
    }

    const grade = compareResults(expected, result, {
      orderMatters: exercise.orderMatters,
      tolerance: exercise.tolerance,
      checkColumnNames: exercise.checkColumnNames,
    });
    if (grade.correct) grade.message = exercise.successMessage || 'Your result matches the expected output.';
    return sendJson(res, 200, { ok: true, result: preview, grade });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/expected/')) {
    const exercise = course.byId.get(decodeURIComponent(pathname.slice('/api/expected/'.length)));
    if (!exercise) return sendJson(res, 404, { ok: false, error: 'Unknown exercise' });
    try {
      const expected = await getExpected(exercise);
      return sendJson(res, 200, { ok: true, result: { ...expected, rows: expected.rows.slice(0, DISPLAY_ROWS) } });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: friendlyError(err) });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  SQL Practice is running → http://localhost:${PORT}\n`);
    console.log(`  Project: ${projectId || '(read from gcloud config)'}`);
    console.log('  Stop with Ctrl+C\n');
  });
}

// ---- .env loader (tiny, no dependency) ----------------------------------------

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

module.exports = { server };
