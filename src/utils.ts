/**
 * Pure utility functions for KingBase MCP Server.
 *
 * Extracted from index.ts so they can be unit-tested independently
 * (index.ts starts the server on import, making direct testing impossible).
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHARACTER_LIMIT = 50000;

// ---------------------------------------------------------------------------
// Access mode (permission levels)
// ---------------------------------------------------------------------------

export type AccessMode = "readonly" | "readwrite" | "full" | "admin";

export const ACCESS_MODE_LEVELS: Record<AccessMode, number> = {
  readonly: 0,
  readwrite: 1,
  full: 2,
  admin: 3,
};

export function getAccessMode(): AccessMode {
  const mode = (process.env.ACCESS_MODE || "readonly").toLowerCase();
  if (mode in ACCESS_MODE_LEVELS) return mode as AccessMode;
  console.error(
    `WARNING: Invalid ACCESS_MODE '${mode}', falling back to 'readonly'.`
  );
  return "readonly";
}

export function hasAccess(required: AccessMode): boolean {
  return ACCESS_MODE_LEVELS[getAccessMode()] >= ACCESS_MODE_LEVELS[required];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getDefaultSchema(): string {
  return process.env.DB_SCHEMA || "public";
}

export function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No rows returned.";

  const columns = Object.keys(rows[0]);

  // Calculate column widths
  const widths = columns.map((col) => {
    const values = rows.map((row) => String(row[col] ?? "NULL"));
    return Math.max(col.length, ...values.map((v) => v.length));
  });

  // Build table
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) =>
    columns
      .map((col, i) => String(row[col] ?? "NULL").padEnd(widths[i]))
      .join(" | ")
  );

  let result = [header, separator, ...body].join("\n");

  if (result.length > CHARACTER_LIMIT) {
    result =
      result.substring(0, CHARACTER_LIMIT) +
      "\n\n... [Output truncated. Use LIMIT or add WHERE conditions to reduce results.]";
  }

  return result;
}

export function handleDbError(error: unknown): string {
  if (error instanceof Error) {
    const pgErr = error as pg.DatabaseError;
    const parts: string[] = [`Error: ${pgErr.message}`];
    if (pgErr.detail) parts.push(`Detail: ${pgErr.detail}`);
    if (pgErr.hint) parts.push(`Hint: ${pgErr.hint}`);
    if (pgErr.position) parts.push(`Position: ${pgErr.position}`);
    if (pgErr.code) parts.push(`Code: ${pgErr.code}`);
    return parts.join("\n");
  }
  return `Error: ${String(error)}`;
}

/** Simple check: does the SQL look like a read-only statement? */
export function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("WITH") ||
    trimmed.startsWith("EXPLAIN") ||
    trimmed.startsWith("SHOW") ||
    trimmed.startsWith("\\D")
  );
}

/** Classify a DML statement by its leading keyword */
export function classifyDML(
  sql: string
): "INSERT" | "UPDATE" | "DELETE" | "OTHER" {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("INSERT")) return "INSERT";
  if (trimmed.startsWith("UPDATE")) return "UPDATE";
  if (trimmed.startsWith("DELETE")) return "DELETE";
  return "OTHER";
}

/** Dangerous DDL keywords that need extra care */
export function isDangerousDDL(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return (
    trimmed.startsWith("DROP") ||
    trimmed.startsWith("TRUNCATE") ||
    trimmed.includes("CASCADE")
  );
}

/** Auto-qualify unqualified table names with schema prefix */
export function qualifyTableNames(sql: string, schema: string): string {
  // Simple approach: replace unqualified table names after specific keywords
  // with schema.tablename format

  // Keywords that can be followed by a table name
  const keywords = ["FROM", "JOIN", "INTO", "UPDATE"];

  let result = sql;

  for (const keyword of keywords) {
    // Pattern: keyword followed by whitespace, then a table name without a dot
    // Matches: FROM table_name, but not FROM schema.table_name
    const pattern = new RegExp(
      `\\b${keyword}\\s+` + // keyword and whitespace
        `(?![\\w"]+\\.)` + // negative lookahead: not followed by "something."
        `([\\w]+)` + // capture the table name (unqualified)
        `(?=[\\s,;\\)\\n]|$)`, // followed by space, comma, semicolon, paren, newline, or end of string
      "gi"
    );

    result = result.replace(pattern, (match, tableName) => {
      // Don't qualify if it's a SQL keyword
      if (
        ["SELECT", "WITH", "VALUES", "TABLE", "NULL"].includes(
          tableName.toUpperCase()
        )
      ) {
        return match;
      }
      // Replace table name with schema.table_name
      return match.replace(tableName, `${schema}.${tableName}`);
    });
  }

  return result;
}
