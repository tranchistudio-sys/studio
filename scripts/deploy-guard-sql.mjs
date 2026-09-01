const DESTRUCTIVE_SQL =
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|SCHEMA|INDEX|SEQUENCE|VIEW)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b[^;]*\bDROP\b/i;

export function stripSqlCommentsAndStrings(sql) {
  const blank = character => character === "\n" || character === "\r" ? character : " ";
  let output = ""; let index = 0; let state = "normal";
  let dollarDelimiter = ""; let blockDepth = 0;
  while (index < sql.length) {
    const current = sql[index]; const next = sql[index + 1];
    if (state === "normal") {
      if (current === "'" || current === '"') {
        state = current === "'" ? "single" : "double"; output += " "; index += 1; continue;
      }
      if (current === "-" && next === "-") { state = "line-comment"; output += "  "; index += 2; continue; }
      if (current === "/" && next === "*") { state = "block-comment"; blockDepth = 1; output += "  "; index += 2; continue; }
      if (current === "$") {
        const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
        if (match) {
          dollarDelimiter = match[0]; state = "dollar";
          output += " ".repeat(dollarDelimiter.length); index += dollarDelimiter.length; continue;
        }
      }
      output += current; index += 1; continue;
    }
    if (state === "line-comment") {
      output += blank(current); index += 1;
      if (current === "\n" || current === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (current === "/" && next === "*") { blockDepth += 1; output += "  "; index += 2; continue; }
      if (current === "*" && next === "/") {
        blockDepth -= 1; output += "  "; index += 2;
        if (blockDepth === 0) state = "normal";
        continue;
      }
      output += blank(current); index += 1; continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarDelimiter, index)) {
        output += " ".repeat(dollarDelimiter.length); index += dollarDelimiter.length; state = "normal";
      } else { output += blank(current); index += 1; }
      continue;
    }
    const quote = state === "single" ? "'" : '"';
    if (current === quote && next === quote) { output += "  "; index += 2; continue; }
    output += blank(current); index += 1;
    if (current === quote) state = "normal";
  }
  return output;
}

export function findDestructiveSql(sql) {
  return stripSqlCommentsAndStrings(sql).match(DESTRUCTIVE_SQL);
}

export function containsDestructiveSql(sql) {
  return Boolean(findDestructiveSql(sql));
}
