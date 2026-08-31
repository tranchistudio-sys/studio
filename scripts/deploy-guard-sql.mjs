const DESTRUCTIVE_SQL =
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|SCHEMA|INDEX|SEQUENCE|VIEW)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b[^;]*\bDROP\b/i;

export function stripSqlCommentsAndStrings(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
}

export function findDestructiveSql(sql) {
  return stripSqlCommentsAndStrings(sql).match(DESTRUCTIVE_SQL);
}

export function containsDestructiveSql(sql) {
  return Boolean(findDestructiveSql(sql));
}
