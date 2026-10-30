// Offline tests: grader logic, exercise files and the full HTTP flow against a
// fake BigQuery API. Run with: npm test
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const { compareResults, checkPatterns, stripSqlNoise } = require('../server/grader');
const { guardSql } = require('../server/sqlguard');

(async () => {
  console.log('\nGrader');
  const exp = { columns: ['category', 'revenue'], rows: [['Jeans', 100.5], ['Tops', 50.25]] };

  await test('identical result is correct', () => {
    assert.ok(compareResults(exp, { columns: ['category', 'revenue'], rows: [['Jeans', 100.5], ['Tops', 50.25]] }).correct);
  });
  await test('row order ignored when orderMatters is false', () => {
    assert.ok(compareResults(exp, { columns: ['category', 'revenue'], rows: [['Tops', 50.25], ['Jeans', 100.5]] }).correct);
  });
  await test('row order checked when orderMatters is true', () => {
    const r = compareResults(exp, { columns: ['category', 'revenue'], rows: [['Tops', 50.25], ['Jeans', 100.5]] }, { orderMatters: true });
    assert.ok(!r.correct && /wrong position/.test(r.message), r.message);
  });
  await test('column order and case ignored', () => {
    assert.ok(compareResults(exp, { columns: ['REVENUE', 'Category'], rows: [[100.5, 'Jeans'], [50.25, 'Tops']] }).correct);
  });
  await test('small rounding differences tolerated', () => {
    assert.ok(compareResults(exp, { columns: ['category', 'revenue'], rows: [['Jeans', 100.5049], ['Tops', 50.2512]] }).correct);
  });
  await test('wrong value reported with column name', () => {
    const r = compareResults(exp, { columns: ['category', 'revenue'], rows: [['Jeans', 90], ['Tops', 50.25]] });
    assert.ok(!r.correct && /revenue = 90/.test(r.message), r.message);
  });
  await test('missing column reported', () => {
    const r = compareResults(exp, { columns: ['category', 'total'], rows: [['Jeans', 100.5], ['Tops', 50.25]] });
    assert.ok(!r.correct && /missing column: revenue/.test(r.message) && /unexpected column: total/.test(r.message), r.message);
  });
  await test('row count mismatch reported', () => {
    const r = compareResults(exp, { columns: ['category', 'revenue'], rows: [['Jeans', 100.5]] });
    assert.ok(!r.correct && /Expected 2 rows but got 1/.test(r.message), r.message);
  });
  await test('NULLs compare equal only to NULL', () => {
    const e = { columns: ['a'], rows: [[null], [1]] };
    assert.ok(compareResults(e, { columns: ['a'], rows: [[1], [null]] }).correct);
    assert.ok(!compareResults(e, { columns: ['a'], rows: [[0], [1]] }).correct);
  });
  await test('arrays compared element-wise', () => {
    const e = { columns: ['c', 'd'], rows: [['Jeans', ['Men', 'Women']]] };
    assert.ok(compareResults(e, { columns: ['c', 'd'], rows: [['Jeans', ['Men', 'Women']]] }).correct);
    assert.ok(!compareResults(e, { columns: ['c', 'd'], rows: [['Jeans', ['Women', 'Men']]] }).correct);
  });
  await test('duplicate rows must match as a multiset', () => {
    const e = { columns: ['a'], rows: [['x'], ['x'], ['y']] };
    assert.ok(!compareResults(e, { columns: ['a'], rows: [['x'], ['y'], ['y']] }).correct);
  });
  await test('per-exercise tolerance', () => {
    const e = { columns: ['p'], rows: [[12.3]] };
    assert.ok(!compareResults(e, { columns: ['p'], rows: [[12.34]] }).correct);
    assert.ok(compareResults(e, { columns: ['p'], rows: [[12.34]] }, { tolerance: 0.05 }).correct);
  });

  console.log('\nSQL helpers');
  await test('comments and strings stripped, backticks kept', () => {
    const s = stripSqlNoise("SELECT '#x -- y' AS a -- QUALIFY\n# comment\nFROM `p-x.d.t` /* QUALIFY */");
    assert.ok(!/QUALIFY/.test(s) && /`p-x\.d\.t`/.test(s) && /FROM/.test(s), s);
  });
  await test('required pattern in comment does not count', () => {
    const ex = { requiredPatterns: [{ pattern: '\\bQUALIFY\\b', message: 'need' }] };
    assert.ok(!checkPatterns('SELECT 1 -- QUALIFY', ex).ok);
    assert.ok(checkPatterns('SELECT 1 FROM t WHERE TRUE QUALIFY x = 1', ex).ok);
  });
  await test('guard allows SELECT and WITH', () => {
    assert.strictEqual(guardSql('SELECT 1'), null);
    assert.strictEqual(guardSql('-- note\nWITH a AS (SELECT 1) SELECT * FROM a;'), null);
  });
  await test('guard blocks DML, multi-statement and blanks', () => {
    assert.ok(guardSql('DELETE FROM t WHERE TRUE'));
    assert.ok(guardSql('SELECT 1; SELECT 2'));
    assert.ok(guardSql('SELECT ___ FROM t'));
    assert.ok(guardSql('CREATE TABLE x AS SELECT 1'));
  });
  await test("guard doesn't trip on keywords inside strings", () => {
    assert.strictEqual(guardSql("SELECT 'delete; drop' AS note"), null);
  });

  console.log('\nExercise files');
  const exDir = path.join(__dirname, '..', 'exercises');
  const schema = JSON.parse(fs.readFileSync(path.join(exDir, 'schema.json'), 'utf8'));
  const tableNames = new Set(schema.tables.map((t) => t.name));
  const columnsOf = Object.fromEntries(schema.tables.map((t) => [t.name, new Set(t.columns.map((c) => c[0]))]));
  const modules = fs.readdirSync(exDir).filter((f) => /^\d+.*\.json$/.test(f)).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(exDir, f), 'utf8')));
  const all = modules.flatMap((m) => m.exercises);
  const join = (v) => (Array.isArray(v) ? v.join('\n') : v);

  await test(`25 exercises across 3 modules (found ${all.length} in ${modules.length})`, () => {
    assert.strictEqual(modules.length, 3);
    assert.strictEqual(all.length, 25);
  });
  await test('exercise ids are unique', () => {
    assert.strictEqual(new Set(all.map((e) => e.id)).size, all.length);
  });
  for (const e of all) {
    await test(`${e.id} is well-formed`, () => {
      for (const k of ['id', 'title', 'context', 'instructions', 'starter', 'solution', 'hints', 'tables']) assert.ok(e[k], `missing ${k}`);
      const starter = join(e.starter);
      const solution = join(e.solution);
      assert.ok(/___/.test(starter), 'starter should contain ___ blanks');
      assert.strictEqual(guardSql(solution), null, 'solution must pass the guard');
      assert.ok(checkPatterns(solution, e).ok, 'solution must satisfy its own required patterns');
      for (const t of e.tables) assert.ok(tableNames.has(t), `unknown table ${t}`);
      // Every table referenced in the solution exists in the schema.
      for (const m of solution.matchAll(/thelook_ecommerce\.(\w+)`/g)) assert.ok(tableNames.has(m[1]), `unknown table ${m[1]}`);
      // Qualified alias.column references point to real columns.
      const aliases = {};
      for (const m of solution.matchAll(/thelook_ecommerce\.(\w+)`\s+(?:AS\s+)?(\w+)/gi)) aliases[m[2]] = m[1];
      for (const m of solution.matchAll(/\b(\w+)\.(\w+)\b/g)) {
        const table = aliases[m[1]];
        if (table) assert.ok(columnsOf[table].has(m[2]), `${m[1]}.${m[2]}: no column ${m[2]} in ${table}`);
      }
      // Balanced parentheses.
      let depth = 0;
      for (const ch of stripSqlNoise(solution)) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; assert.ok(depth >= 0, 'unbalanced )'); }
      assert.strictEqual(depth, 0, 'unbalanced (');
      // Starter and solution should be the same query apart from the blanks.
      const pattern = starter.split('___').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?');
      if (!/IGNORE NULLS/.test(solution)) assert.ok(new RegExp('^' + pattern + '$').test(solution), 'solution does not fit the starter template');
    });
  }

  console.log('\nHTTP flow against a fake BigQuery');
  // Fake BigQuery: answers based on a marker in the SQL.
  const fakeRows = {
    good: { fields: [{ name: 'status', type: 'STRING' }, { name: 'num_orders', type: 'INTEGER' }], rows: [['Complete', '10'], ['Returned', '3']] },
    wrong: { fields: [{ name: 'status', type: 'STRING' }, { name: 'num_orders', type: 'INTEGER' }], rows: [['Complete', '11'], ['Returned', '3']] },
    ts: { fields: [{ name: 'created_at', type: 'TIMESTAMP' }, { name: 'tags', type: 'STRING', mode: 'REPEATED' }, { name: 's', type: 'RECORD', fields: [{ name: 'a', type: 'INTEGER' }] }], rows: [['1672531200000000', [{ v: 'x' }, { v: 'y' }], { f: [{ v: '7' }] }]] },
  };
  const calls = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      calls.push({ method: req.method, url: req.url, json });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.includes('/queries/job-slow')) {
        const d = fakeRows.good;
        return res.end(JSON.stringify({ jobComplete: true, schema: { fields: d.fields }, rows: d.rows.map((r) => ({ f: r.map((v) => ({ v })) })), totalRows: '2' }));
      }
      const q = json.query || '';
      if (/syntaxerror/.test(q)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Syntax error: Unexpected identifier at [1:8]' } }));
      }
      if (json.dryRun) return res.end(JSON.stringify({ totalBytesProcessed: '1048576', jobComplete: true }));
      if (/slowjob/.test(q)) return res.end(JSON.stringify({ jobComplete: false, jobReference: { jobId: 'job-slow', location: 'US' } }));
      const key = /wrongmarker/.test(q) ? 'wrong' : /tsmarker/.test(q) ? 'ts' : 'good';
      const d = fakeRows[key];
      res.end(JSON.stringify({
        jobComplete: true,
        jobReference: { jobId: 'job-1', location: 'US' },
        schema: { fields: d.fields },
        rows: d.rows.map((r) => ({ f: r.map((v) => ({ v })) })),
        totalRows: String(d.rows.length),
        totalBytesProcessed: '2048',
      }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.BQ_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.BQ_ACCESS_TOKEN = 'test-token';
  process.env.GCP_PROJECT_ID = 'test-project';
  delete require.cache[require.resolve('../server/bigquery')];
  delete require.cache[require.resolve('../server/index')];
  const { server } = require('../server/index');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

  await test('GET / serves the app', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('SQL Lab'));
  });
  await test('static files cannot escape the public folder', async () => {
    const r = await fetch(base + '/..%2Fserver%2Findex.js');
    assert.notStrictEqual(r.status, 200);
  });
  await test('GET /api/course returns modules with joined text', async () => {
    const c = await fetch(base + '/api/course').then((r) => r.json());
    assert.strictEqual(c.modules.length, 3);
    assert.strictEqual(typeof c.modules[0].exercises[0].starter, 'string');
    assert.ok(c.schema.tables.length >= 7);
  });
  await test('GET /api/status reports connected', async () => {
    const s = await fetch(base + '/api/status').then((r) => r.json());
    assert.ok(s.ok && s.projectId === 'test-project', JSON.stringify(s));
  });
  await test('run returns converted rows, bytes and sends auth + default dataset', async () => {
    const d = await post('/api/run', { sql: 'SELECT 1 -- good' });
    assert.ok(d.ok, JSON.stringify(d));
    assert.deepStrictEqual(d.result.rows, [['Complete', 10], ['Returned', 3]]);
    const last = calls[calls.length - 1];
    assert.strictEqual(last.json.defaultDataset.datasetId, 'thelook_ecommerce');
    assert.ok(last.json.maximumBytesBilled);
  });
  await test('TIMESTAMP, ARRAY and STRUCT values are converted', async () => {
    const d = await post('/api/run', { sql: 'SELECT 1 -- tsmarker' });
    assert.deepStrictEqual(d.result.rows[0], ['2023-01-01T00:00:00Z', ['x', 'y'], { a: 7 }]);
    assert.strictEqual(d.result.types[1], 'ARRAY<STRING>');
  });
  await test('BigQuery errors are passed through', async () => {
    const d = await post('/api/run', { sql: 'SELECT syntaxerror' });
    assert.ok(!d.ok && /Syntax error/.test(d.error), JSON.stringify(d));
  });
  await test('unfinished jobs are polled', async () => {
    const d = await post('/api/run', { sql: 'SELECT 1 -- slowjob' });
    assert.ok(d.ok && d.result.rows.length === 2, JSON.stringify(d));
  });
  await test('guard rejects blanks before calling BigQuery', async () => {
    const before = calls.length;
    const d = await post('/api/run', { sql: 'SELECT ___' });
    assert.ok(!d.ok && /blanks/.test(d.error));
    assert.strictEqual(calls.length, before);
  });
  await test('submit: matching result is graded correct', async () => {
    const d = await post('/api/submit', { exerciseId: 'm1-e01', sql: 'SELECT status, COUNT(*) AS num_orders FROM orders GROUP BY status' });
    assert.ok(d.ok && d.grade.correct, JSON.stringify(d.grade));
  });
  await test('submit: wrong result gets feedback', async () => {
    const d = await post('/api/submit', { exerciseId: 'm1-e01', sql: 'SELECT status, COUNT(*) AS num_orders FROM orders GROUP BY status -- wrongmarker' });
    assert.ok(d.ok && !d.grade.correct && /num_orders = 11/.test(d.grade.message), JSON.stringify(d.grade));
  });
  await test('submit: required pattern enforced', async () => {
    const d = await post('/api/submit', { exerciseId: 'm1-e04', sql: 'SELECT COUNT(*) AS users_without_orders FROM users WHERE id NOT IN (SELECT user_id FROM orders)' });
    assert.ok(d.ok && !d.grade.correct && /LEFT JOIN/.test(d.grade.message), JSON.stringify(d.grade));
  });
  await test('expected output is cached per day', async () => {
    const before = calls.filter((c) => c.json.query && c.json.query.includes('GROUP BY status') && !c.json.dryRun && !/--/.test(c.json.query)).length;
    await post('/api/submit', { exerciseId: 'm1-e01', sql: 'SELECT status, COUNT(*) AS num_orders FROM orders GROUP BY status' });
    const solutionRuns = calls.filter((c) => c.json.query && c.json.query.startsWith('SELECT\n  status,\n  COUNT(*)') && !c.json.dryRun).length;
    assert.strictEqual(solutionRuns, 1, `solution ran ${solutionRuns} times`);
    assert.ok(before >= 0);
  });
  await test('GET /api/expected/:id returns the reference output', async () => {
    const d = await fetch(base + '/api/expected/m1-e01').then((r) => r.json());
    assert.ok(d.ok && d.result.rows.length === 2);
  });

  server.close();
  fake.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
