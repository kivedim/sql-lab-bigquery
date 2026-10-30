'use strict';

const { stripSqlNoise } = require('./grader');

// Only read-only queries are allowed: one statement starting with SELECT or WITH.
function guardSql(sql) {
  if (!sql || !sql.trim()) return 'Write a query first.';
  const clean = stripSqlNoise(sql).trim().replace(/;\s*$/, '');
  if (clean.includes(';')) return 'Only one statement at a time, please (remove the extra semicolon).';
  if (!/^\(*\s*(SELECT|WITH)\b/i.test(clean)) return 'Only SELECT queries (optionally starting with WITH) are allowed in this app.';
  if (/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|EXPORT|LOAD|CALL|DECLARE|EXECUTE)\b/i.test(clean))
    return 'This app only runs read-only SELECT queries.';
  if (/___/.test(sql)) return 'Fill in the blanks (___) before running your code.';
  return null;
}

module.exports = { guardSql };
