// Compares a learner's query result with the expected result and produces
// DataCamp-style feedback. Pure functions — no I/O — so it is easy to test.

'use strict';

const DEFAULT_TOLERANCE = 0.01;

function stripSqlNoise(sql) {
  // Remove comments and blank out string literals (single pass, so a '#' or
  // '--' inside a string is not mistaken for a comment). Backtick identifiers
  // are kept as they are.
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== ch) i += sql[i] === '\\' ? 2 : 1;
      i++;
      out += ch + ch;
    } else if (ch === '`') {
      const end = sql.indexOf('`', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function checkPatterns(sql, exercise) {
  const clean = stripSqlNoise(sql);
  for (const rule of exercise.requiredPatterns || []) {
    if (!new RegExp(rule.pattern, rule.flags || 'i').test(clean)) {
      return { ok: false, message: rule.message };
    }
  }
  for (const rule of exercise.forbiddenPatterns || []) {
    if (new RegExp(rule.pattern, rule.flags || 'i').test(clean)) {
      return { ok: false, message: rule.message };
    }
  }
  return { ok: true };
}

function isNumeric(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function valuesEqual(a, b, tol) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (isNumeric(a) && isNumeric(b)) {
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= tol + 1e-9 * scale;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i], tol));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).map((k) => k.toLowerCase()).sort();
    const kb = Object.keys(b).map((k) => k.toLowerCase()).sort();
    if (ka.join('|') !== kb.join('|')) return false;
    const la = lowerKeys(a);
    const lb = lowerKeys(b);
    return ka.every((k) => valuesEqual(la[k], lb[k], tol));
  }
  return String(a) === String(b);
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function rowToText(columns, row) {
  return '{ ' + columns.map((c, i) => `${c}: ${fmt(row[i])}`).join(', ') + ' }';
}

function rowsEqual(a, b, tol) {
  return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i], tol));
}

// Key used to bucket rows quickly: all non-numeric values joined.
function bucketKey(row) {
  return row.map((v) => (isNumeric(v) ? '#' : JSON.stringify(v))).join('\u0001');
}

/**
 * expected / actual: { columns: string[], rows: any[][] }
 * opts: { orderMatters, tolerance, checkColumnNames }
 */
function compareResults(expected, actual, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const checkNames = opts.checkColumnNames !== false;

  const expCols = expected.columns.map((c) => c.toLowerCase());
  const actCols = actual.columns.map((c) => c.toLowerCase());

  if (checkNames) {
    const missing = expCols.filter((c) => !actCols.includes(c));
    const extra = actCols.filter((c) => !expCols.includes(c));
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
      if (extra.length) parts.push(`unexpected column${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
      return fail(
        `Your result has the wrong columns (${parts.join('; ')}). ` +
          `Expected exactly: ${expCols.join(', ')}. Check your aliases with AS.`
      );
    }
    const dupes = actCols.filter((c, i) => actCols.indexOf(c) !== i);
    if (dupes.length) return fail(`Column name ${dupes[0]} appears more than once.`);
  } else if (expCols.length !== actCols.length) {
    return fail(`Expected ${expCols.length} columns but your result has ${actCols.length}.`);
  }

  // Reorder actual columns to match expected order (column order never matters).
  const idx = checkNames ? expCols.map((c) => actCols.indexOf(c)) : expCols.map((_, i) => i);
  const actRows = actual.rows.map((r) => idx.map((i) => r[i]));
  const expRows = expected.rows;

  if (actRows.length !== expRows.length) {
    const hint =
      actRows.length > expRows.length
        ? 'Too many rows — check your filters, joins (duplicates?) and GROUP BY.'
        : 'Too few rows — check your WHERE conditions and join type.';
    return fail(`Expected ${expRows.length} row${expRows.length === 1 ? '' : 's'} but got ${actRows.length}. ${hint}`);
  }

  if (opts.orderMatters) {
    for (let r = 0; r < expRows.length; r++) {
      if (!rowsEqual(expRows[r], actRows[r], tol)) {
        const c = expRows[r].findIndex((v, i) => !valuesEqual(v, actRows[r][i], tol));
        // Is the row present elsewhere? Then it is an ordering problem.
        const elsewhere = actRows.some((row) => rowsEqual(expRows[r], row, tol));
        if (elsewhere) {
          return fail(`Row ${r + 1} is in the wrong position. Check your ORDER BY.`);
        }
        return fail(
          `Row ${r + 1}, column ${expCols[c]}: expected ${fmt(expRows[r][c])} but got ${fmt(actRows[r][c])}.`
        );
      }
    }
    return { correct: true };
  }

  // Order-independent multiset comparison.
  const buckets = new Map();
  actRows.forEach((row, i) => {
    const k = bucketKey(row);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });
  const used = new Set();
  const unmatchedExpected = [];
  for (const row of expRows) {
    const cands = buckets.get(bucketKey(row)) || [];
    const hit = cands.find((i) => !used.has(i) && rowsEqual(row, actRows[i], tol));
    if (hit === undefined) {
      // Fallback: slower scan (handles edge cases such as NULL vs number).
      const any = actRows.findIndex((r, i) => !used.has(i) && rowsEqual(row, r, tol));
      if (any === -1) unmatchedExpected.push(row);
      else used.add(any);
    } else used.add(hit);
  }
  if (unmatchedExpected.length === 0) return { correct: true };

  const unmatchedActual = actRows.filter((_, i) => !used.has(i));
  let msg = `${unmatchedExpected.length} of ${expRows.length} rows don't match. For example, this expected row is missing: ${rowToText(expCols, unmatchedExpected[0])}`;
  // Try to find the "closest" wrong row to make the feedback concrete.
  const near = unmatchedActual.find((r) => r.some((v, i) => !isNumeric(v) && valuesEqual(v, unmatchedExpected[0][i], tol)));
  if (near) {
    const c = unmatchedExpected[0].findIndex((v, i) => !valuesEqual(v, near[i], tol));
    msg += `. Your closest row has ${expCols[c]} = ${fmt(near[c])}`;
    if (isNumeric(near[c]) && isNumeric(unmatchedExpected[0][c])) msg += ' — check your calculation, filters and rounding';
    msg += '.';
  }
  return fail(msg);
}

function fail(message) {
  return { correct: false, message };
}

module.exports = { compareResults, checkPatterns, stripSqlNoise, valuesEqual };
