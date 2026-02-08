#!/usr/bin/env node
/**
 * KingBase MCP Server
 *
 * Provides tools to interact with KingBase (PostgreSQL-compatible) databases,
 * including query execution, DDL operations, schema inspection, and more.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARACTER_LIMIT = 50000;
const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Access mode (permission levels)
// ---------------------------------------------------------------------------

type AccessMode = "readonly" | "readwrite" | "full" | "admin";

const ACCESS_MODE_LEVELS: Record<AccessMode, number> = {
  readonly: 0,
  readwrite: 1,
  full: 2,
  admin: 3,
};

function getAccessMode(): AccessMode {
  const mode = (process.env.ACCESS_MODE || "readonly").toLowerCase();
  if (mode in ACCESS_MODE_LEVELS) return mode as AccessMode;
  console.error(
    `WARNING: Invalid ACCESS_MODE '${mode}', falling back to 'readonly'.`
  );
  return "readonly";
}

function hasAccess(required: AccessMode): boolean {
  return ACCESS_MODE_LEVELS[getAccessMode()] >= ACCESS_MODE_LEVELS[required];
}

// ---------------------------------------------------------------------------
// Tool Registry for Documentation and Discovery
// ---------------------------------------------------------------------------

interface ToolMetadata {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const TOOL_REGISTRY: Map<string, ToolMetadata> = new Map();

function registerToolWithMetadata(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  },
  handler: (params: any) => Promise<any>
): void {
  // Store metadata in registry
  TOOL_REGISTRY.set(name, {
    name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    annotations: config.annotations,
  });

  // Register with MCP server
  server.registerTool(name, config, handler);
}

function toolMetadataToJson(tool: ToolMetadata) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema, {
      $refStrategy: "none",
      name: tool.name + "Schema",
    }),
    annotations: tool.annotations,
  };
}

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

function createPool(): pg.Pool {
  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "54321", 10),
    user: process.env.DB_USER || "system",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "kingbase",
    // Connection pool settings
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on("error", (err) => {
    console.error("Unexpected pool error:", err.message);
  });

  return pool;
}

let pool: pg.Pool;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultSchema(): string {
  return process.env.DB_SCHEMA || "public";
}

async function executeQuery(
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

function formatRows(rows: Record<string, unknown>[]): string {
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

function handleDbError(error: unknown): string {
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
function isReadOnly(sql: string): boolean {
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
function classifyDML(sql: string): "INSERT" | "UPDATE" | "DELETE" | "OTHER" {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("INSERT")) return "INSERT";
  if (trimmed.startsWith("UPDATE")) return "UPDATE";
  if (trimmed.startsWith("DELETE")) return "DELETE";
  return "OTHER";
}

/** Dangerous DDL keywords that need extra care */
function isDangerousDDL(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return (
    trimmed.startsWith("DROP") ||
    trimmed.startsWith("TRUNCATE") ||
    trimmed.includes("CASCADE")
  );
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "kingbase-mcp-server",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {

// ---------------------------------------------------------------------------
// Tool: kb_query
// ---------------------------------------------------------------------------

const QueryInputSchema = z
  .object({
    sql: z
      .string()
      .min(1, "SQL query is required")
      .describe("SELECT query to execute. Only read-only statements are allowed."),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Optional parameterized query values ($1, $2, ...)"),
    schema: z
      .string()
      .optional()
      .describe("Schema name for tables without explicit schema prefix (default: from DB_SCHEMA env or 'public'). When specified, unqualified table names will be automatically prefixed with this schema."),
  })
  .strict();

/** Auto-qualify unqualified table names with schema prefix */
function qualifyTableNames(sql: string, schema: string): string {
  // Simple approach: replace unqualified table names after specific keywords
  // with schema.tablename format

  // Keywords that can be followed by a table name
  const keywords = ['FROM', 'JOIN', 'INTO', 'UPDATE'];

  let result = sql;

  for (const keyword of keywords) {
    // Pattern: keyword followed by whitespace, then a table name without a dot
    // Matches: FROM table_name, but not FROM schema.table_name
    const pattern = new RegExp(
      `\\b${keyword}\\s+` +        // keyword and whitespace
      `(?![\\w"]+\\.)` +           // negative lookahead: not followed by "something."
      `([\\w]+)` +                 // capture the table name (unqualified)
      `(?=[\\s,;\\)\\n]|$)`,       // followed by space, comma, semicolon, paren, newline, or end of string
      'gi'
    );

    result = result.replace(pattern, (match, tableName) => {
      // Don't qualify if it's a SQL keyword
      if (['SELECT', 'WITH', 'VALUES', 'TABLE', 'NULL'].includes(tableName.toUpperCase())) {
        return match;
      }
      // Replace table name with schema.table_name
      return match.replace(tableName, `${schema}.${tableName}`);
    });
  }

  return result;
}

registerToolWithMetadata(server, "kb_query", {
  title: "Execute Query",
  description: `Execute a read-only SQL query (SELECT/WITH/SHOW) against the KingBase database.

Returns query results as a formatted table. Use parameterized queries ($1, $2, ...) for safe value substitution.

Only read-only statements are allowed. For INSERT/UPDATE/DELETE use kb_execute; for DDL use kb_execute_ddl.

🔑 Auto-schema feature: Unqualified table names (without schema prefix) are automatically qualified with the configured schema (DB_SCHEMA env var). You can optionally override this with the 'schema' parameter.

Args:
  - sql (string): The SELECT query to execute
  - params (array, optional): Parameter values for $1, $2, ... placeholders
  - schema (string, optional): Override the default schema for auto-qualifying table names

Returns:
  Formatted table of query results with row count.

Examples:
  - sql: "SELECT * FROM biz_cm_attachment LIMIT 5" (auto-qualified with configured schema)
  - sql: "SELECT * FROM users WHERE status = $1", params: ["active"]
  - sql: "SELECT * FROM public.sys_user" (explicit schema, not auto-qualified)`,
  inputSchema: QueryInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    if (!isReadOnly(params.sql)) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Error: Only read-only queries (SELECT/WITH/SHOW) are allowed. Use kb_execute for DML or kb_execute_ddl for DDL.",
        }],
      };
    }

    // Auto-qualify table names with configured schema
    const schema = params.schema || getDefaultSchema();
    let sql = params.sql;

    // Apply schema auto-qualification for unqualified table names
    sql = qualifyTableNames(sql, schema);

    const result = await executeQuery(sql, params.params ?? undefined);
    const rowCount = result.rows.length;
    const table = formatRows(result.rows);

    return {
      content: [{
        type: "text" as const,
        text: `${table}\n\n(${rowCount} row${rowCount !== 1 ? "s" : ""})`,
      }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_execute
// ---------------------------------------------------------------------------

const ExecuteInputSchema = z
  .object({
    sql: z
      .string()
      .min(1, "SQL statement is required")
      .describe("DML statement (INSERT/UPDATE/DELETE) to execute"),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Optional parameterized query values ($1, $2, ...)"),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Set to true to confirm execution. First call without this returns a preview for confirmation."),
    schema: z
      .string()
      .optional()
      .describe("Schema name for tables without explicit schema prefix (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_execute", {
  title: "Execute DML",
  description: `Execute a DML statement (INSERT, UPDATE, DELETE) against the KingBase database.

Returns the number of affected rows. Use parameterized queries ($1, $2, ...) for safe value substitution.

🔑 Auto-schema feature: Unqualified table names (without schema prefix) are automatically qualified with the configured schema (DB_SCHEMA env var). You can optionally override this with the 'schema' parameter.

Args:
  - sql (string): The DML statement to execute
  - params (array, optional): Parameter values for $1, $2, ... placeholders
  - schema (string, optional): Override the default schema for auto-qualifying table names

Returns:
  Number of rows affected by the operation.

Examples:
  - sql: "UPDATE users SET status = $1 WHERE id = $2", params: ["inactive", 123]
  - sql: "INSERT INTO users (name, email) VALUES ($1, $2)", params: ["John", "john@example.com"]
  - sql: "DELETE FROM logs WHERE created_at < $1", params: ["2024-01-01"]`,
  inputSchema: ExecuteInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const dmlType = classifyDML(params.sql);
    const requiredMode: AccessMode = dmlType === "DELETE" ? "full" : "readwrite";

    // Permission check
    if (!hasAccess(requiredMode)) {
      const currentMode = getAccessMode();
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Access denied: ${dmlType} operations require ACCESS_MODE '${requiredMode}' or higher (current: '${currentMode}'). Please contact your administrator to change the ACCESS_MODE setting.`,
        }],
      };
    }

    // Auto-qualify table names with configured schema
    const schema = params.schema || getDefaultSchema();
    let sql = params.sql;
    sql = qualifyTableNames(sql, schema);

    // Confirmation check
    if (!params.confirmed) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `⚠️ Confirmation required for ${dmlType} operation.`,
            "",
            "SQL statement to execute:",
            "```sql",
            sql,
            "```",
            params.params ? `Parameters: ${JSON.stringify(params.params)}` : "",
            "",
            "Please call this tool again with `confirmed: true` to execute.",
          ].filter(Boolean).join("\n"),
        }],
      };
    }

    const result = await executeQuery(sql, params.params ?? undefined);
    const affected = result.rowCount ?? 0;

    let text = `Statement executed successfully. ${affected} row${affected !== 1 ? "s" : ""} affected.`;

    if (result.rows && result.rows.length > 0) {
      text += "\n\nReturning:\n" + formatRows(result.rows);
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_execute_ddl
// ---------------------------------------------------------------------------

const ExecuteDDLInputSchema = z
  .object({
    sql: z
      .string()
      .min(1, "DDL statement is required")
      .describe("DDL statement (CREATE/ALTER/DROP/TRUNCATE) to execute"),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Set to true to confirm execution. First call without this returns a preview for confirmation."),
    schema: z
      .string()
      .optional()
      .describe("Schema name for tables without explicit schema prefix (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_execute_ddl", {
  title: "Execute DDL",
  description: `Execute a DDL statement (CREATE, ALTER, DROP, TRUNCATE, etc.) against the KingBase database.

WARNING: DDL operations modify database structure and can be destructive. DROP and TRUNCATE operations are irreversible.

🔑 Auto-schema feature: Unqualified table names (without schema prefix) are automatically qualified with the configured schema (DB_SCHEMA env var). You can optionally override this with the 'schema' parameter.

Args:
  - sql (string): The DDL statement to execute
  - schema (string, optional): Override the default schema for auto-qualifying table names

Returns:
  Confirmation message. For dangerous operations (DROP/TRUNCATE/CASCADE), a warning is included.

Examples:
  - sql: "CREATE TABLE test (id SERIAL PRIMARY KEY, name VARCHAR(100))"
  - sql: "ALTER TABLE users ADD COLUMN phone VARCHAR(20)"
  - sql: "CREATE INDEX idx_users_email ON users(email)"`,
  inputSchema: ExecuteDDLInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    // Permission check
    if (!hasAccess("admin")) {
      const currentMode = getAccessMode();
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Access denied: DDL operations require ACCESS_MODE 'admin' (current: '${currentMode}'). Please contact your administrator to change the ACCESS_MODE setting.`,
        }],
      };
    }

    // Auto-qualify table names with configured schema
    const schema = params.schema || getDefaultSchema();
    let sql = params.sql;
    sql = qualifyTableNames(sql, schema);

    const dangerous = isDangerousDDL(sql);

    // Confirmation check
    if (!params.confirmed) {
      return {
        content: [{
          type: "text" as const,
          text: [
            dangerous
              ? "🚨 Confirmation required for DANGEROUS DDL operation (DROP/TRUNCATE/CASCADE)."
              : "⚠️ Confirmation required for DDL operation.",
            "",
            "SQL statement to execute:",
            "```sql",
            sql,
            "```",
            "",
            dangerous
              ? "WARNING: This operation is destructive and CANNOT be undone!"
              : "",
            "Please call this tool again with `confirmed: true` to execute.",
          ].filter(Boolean).join("\n"),
        }],
      };
    }

    await executeQuery(sql);

    let text = "DDL statement executed successfully.";
    if (dangerous) {
      text = "WARNING: Destructive DDL executed successfully. This operation cannot be undone.";
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_list_schemas
// ---------------------------------------------------------------------------

const ListSchemasInputSchema = z.object({}).strict();

registerToolWithMetadata(server, "kb_list_schemas", {
  title: "List Schemas",
  description: `List all schemas in the KingBase database.

Returns schema names excluding internal PostgreSQL/KingBase system schemas.

Args: None

Returns:
  List of schema names with their owners.`,
  inputSchema: ListSchemasInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
  try {
    const result = await executeQuery(`
      SELECT schema_name, schema_owner
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'sys_catalog')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name
    `);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No user schemas found." }] };
    }

    const lines = ["# Schemas", ""];
    for (const row of result.rows) {
      lines.push(`- **${row.schema_name}** (owner: ${row.schema_owner})`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_list_tables
// ---------------------------------------------------------------------------

const ListTablesInputSchema = z
  .object({
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
    type: z
      .enum(["table", "view", "all"])
      .default("all")
      .describe("Filter by object type: 'table', 'view', or 'all' (default: 'all')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_list_tables", {
  title: "List Tables",
  description: `List all tables and/or views in a schema.

Args:
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'
  - type ('table' | 'view' | 'all'): Filter by type (default: 'all')

Returns:
  List of tables/views with their type, owner, and estimated row count.`,
  inputSchema: ListTablesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();
    const typeFilter =
      params.type === "table"
        ? "AND c.relkind = 'r'"
        : params.type === "view"
          ? "AND c.relkind IN ('v', 'm')"
          : "AND c.relkind IN ('r', 'v', 'm')";

    const result = await executeQuery(
      `
      SELECT
        c.relname AS name,
        CASE c.relkind
          WHEN 'r' THEN 'table'
          WHEN 'v' THEN 'view'
          WHEN 'm' THEN 'materialized view'
        END AS type,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        c.reltuples::bigint AS estimated_rows,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        ${typeFilter}
      ORDER BY c.relname
      `,
      [schema]
    );

    if (result.rows.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No ${params.type === "all" ? "tables or views" : params.type + "s"} found in schema '${schema}'.`,
        }],
      };
    }

    const lines = [`# Tables in schema '${schema}'`, ""];
    lines.push("| Name | Type | Owner | Est. Rows | Comment |");
    lines.push("|------|------|-------|-----------|---------|");
    for (const row of result.rows) {
      const comment = row.comment || "";
      lines.push(
        `| ${row.name} | ${row.type} | ${row.owner} | ${row.estimated_rows} | ${comment} |`
      );
    }
    lines.push("", `Total: ${result.rows.length} object(s)`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_describe_table
// ---------------------------------------------------------------------------

const DescribeTableInputSchema = z
  .object({
    table: z
      .string()
      .min(1, "Table name is required")
      .describe("Table or view name to describe"),
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_describe_table", {
  title: "Describe Table",
  description: `Get detailed structure of a table or view, including columns, types, constraints, and comments.

Args:
  - table (string): Table or view name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  Table structure with column names, data types, nullable, defaults, and comments.`,
  inputSchema: DescribeTableInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();

    const result = await executeQuery(
      `
      SELECT
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
        col_description(c.oid, a.attnum) AS comment
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
      `,
      [schema, params.table]
    );

    if (result.rows.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `Table '${schema}.${params.table}' not found or has no columns.`,
        }],
      };
    }

    // Also get primary key info
    const pkResult = await executeQuery(
      `
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary
        AND n.nspname = $1
        AND c.relname = $2
      `,
      [schema, params.table]
    );

    const pkColumns = new Set(pkResult.rows.map((r) => r.attname));

    const lines = [`# Table: ${schema}.${params.table}`, ""];
    lines.push("| # | Column | Type | Nullable | Default | PK | Comment |");
    lines.push("|---|--------|------|----------|---------|----|---------| ");
    result.rows.forEach((row, idx) => {
      const pk = pkColumns.has(row.column_name) ? "PK" : "";
      const def = row.default_value || "";
      const comment = row.comment || "";
      lines.push(
        `| ${idx + 1} | ${row.column_name} | ${row.data_type} | ${row.nullable} | ${def} | ${pk} | ${comment} |`
      );
    });
    lines.push("", `Total: ${result.rows.length} column(s)`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_list_indexes
// ---------------------------------------------------------------------------

const ListIndexesInputSchema = z
  .object({
    table: z
      .string()
      .min(1, "Table name is required")
      .describe("Table name to list indexes for"),
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_list_indexes", {
  title: "List Indexes",
  description: `List all indexes on a table including columns, uniqueness, and index type.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  List of indexes with name, columns, uniqueness, and method (btree/hash/gin/gist).`,
  inputSchema: ListIndexesInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();

    const result = await executeQuery(
      `
      SELECT
        i.relname AS index_name,
        am.amname AS method,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = $1
        AND t.relname = $2
      ORDER BY i.relname
      `,
      [schema, params.table]
    );

    if (result.rows.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No indexes found on '${schema}.${params.table}'.`,
        }],
      };
    }

    const lines = [`# Indexes on ${schema}.${params.table}`, ""];
    for (const row of result.rows) {
      const flags = [];
      if (row.is_primary) flags.push("PRIMARY KEY");
      if (row.is_unique && !row.is_primary) flags.push("UNIQUE");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";

      lines.push(`## ${row.index_name}${flagStr}`);
      lines.push(`- Method: ${row.method}`);
      lines.push(`- Definition: \`${row.definition}\``);
      lines.push("");
    }
    lines.push(`Total: ${result.rows.length} index(es)`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_list_constraints
// ---------------------------------------------------------------------------

const ListConstraintsInputSchema = z
  .object({
    table: z
      .string()
      .min(1, "Table name is required")
      .describe("Table name to list constraints for"),
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_list_constraints", {
  title: "List Constraints",
  description: `List all constraints (PK, FK, UNIQUE, CHECK) on a table.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  List of constraints with name, type, columns, and referenced table (for FK).`,
  inputSchema: ListConstraintsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();

    const result = await executeQuery(
      `
      SELECT
        con.conname AS constraint_name,
        CASE con.contype
          WHEN 'p' THEN 'PRIMARY KEY'
          WHEN 'f' THEN 'FOREIGN KEY'
          WHEN 'u' THEN 'UNIQUE'
          WHEN 'c' THEN 'CHECK'
          WHEN 'x' THEN 'EXCLUSION'
        END AS constraint_type,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
      ORDER BY con.contype, con.conname
      `,
      [schema, params.table]
    );

    if (result.rows.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No constraints found on '${schema}.${params.table}'.`,
        }],
      };
    }

    const lines = [`# Constraints on ${schema}.${params.table}`, ""];
    lines.push("| Name | Type | Definition |");
    lines.push("|------|------|------------|");
    for (const row of result.rows) {
      lines.push(
        `| ${row.constraint_name} | ${row.constraint_type} | \`${row.definition}\` |`
      );
    }
    lines.push("", `Total: ${result.rows.length} constraint(s)`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_explain
// ---------------------------------------------------------------------------

const ExplainInputSchema = z
  .object({
    sql: z
      .string()
      .min(1, "SQL query is required")
      .describe("SQL query to explain"),
    analyze: z
      .boolean()
      .default(false)
      .describe("Run EXPLAIN ANALYZE (actually executes the query) for real timing data"),
    format: z
      .enum(["text", "json", "yaml"])
      .default("text")
      .describe("Output format for the execution plan"),
  })
  .strict();

registerToolWithMetadata(server, "kb_explain", {
  title: "Explain Query",
  description: `Get the execution plan for a SQL query using EXPLAIN.

Use this to analyze query performance, identify full table scans, and optimize queries.

Args:
  - sql (string): The SQL query to explain
  - analyze (boolean, default false): If true, actually executes the query (EXPLAIN ANALYZE) for real timing data
  - format ('text' | 'json' | 'yaml'): Output format (default: 'text')

Returns:
  Query execution plan showing scan types, costs, and join strategies.

Examples:
  - sql: "SELECT * FROM users WHERE email = 'test@example.com'"
  - sql: "SELECT u.*, o.* FROM users u JOIN orders o ON u.id = o.user_id", analyze: true`,
  inputSchema: ExplainInputSchema,
  annotations: {
    readOnlyHint: false, // ANALYZE actually executes
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const explainCmd = params.analyze ? "EXPLAIN ANALYZE" : "EXPLAIN";
    const formatClause =
      params.format !== "text" ? `(FORMAT ${params.format.toUpperCase()})` : "";

    const result = await executeQuery(
      `${explainCmd} ${formatClause} ${params.sql}`
    );

    const plan = result.rows
      .map((row) => Object.values(row)[0])
      .join("\n");

    return {
      content: [{ type: "text" as const, text: `# Execution Plan\n\n\`\`\`\n${plan}\n\`\`\`` }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_table_data
// ---------------------------------------------------------------------------

const TableDataInputSchema = z
  .object({
    table: z
      .string()
      .min(1, "Table name is required")
      .describe("Table name to preview data from"),
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROW_LIMIT)
      .default(DEFAULT_ROW_LIMIT)
      .describe(`Number of rows to return (default: ${DEFAULT_ROW_LIMIT}, max: ${MAX_ROW_LIMIT})`),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of rows to skip (default: 0)"),
    where: z
      .string()
      .optional()
      .describe("Optional WHERE clause (without the WHERE keyword), e.g. \"status = 'active'\""),
    order_by: z
      .string()
      .optional()
      .describe("Optional ORDER BY clause (without the ORDER BY keyword), e.g. \"created_at DESC\""),
  })
  .strict();

registerToolWithMetadata(server, "kb_table_data", {
  title: "Preview Table Data",
  description: `Preview data from a table with optional filtering and pagination.

A convenient shortcut for common SELECT operations without writing full SQL.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'
  - limit (number, default 100, max 1000): Number of rows
  - offset (number, default 0): Rows to skip
  - where (string, optional): WHERE condition (without WHERE keyword)
  - order_by (string, optional): ORDER BY clause (without ORDER BY keyword)

Returns:
  Formatted table of row data with total count.

Examples:
  - table: "users", limit: 10, where: "status = 'active'", order_by: "created_at DESC"
  - table: "orders", limit: 50, offset: 100`,
  inputSchema: TableDataInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();
    const qualifiedTable = `"${schema}"."${params.table}"`;

    let countSql = `SELECT count(*) AS total FROM ${qualifiedTable}`;
    let dataSql = `SELECT * FROM ${qualifiedTable}`;

    if (params.where) {
      countSql += ` WHERE ${params.where}`;
      dataSql += ` WHERE ${params.where}`;
    }
    if (params.order_by) {
      dataSql += ` ORDER BY ${params.order_by}`;
    }
    dataSql += ` LIMIT ${params.limit} OFFSET ${params.offset}`;

    const [countResult, dataResult] = await Promise.all([
      executeQuery(countSql),
      executeQuery(dataSql),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    const table = formatRows(dataResult.rows);
    const showing = dataResult.rows.length;
    const hasMore = params.offset + showing < total;

    const lines = [
      table,
      "",
      `Showing ${params.offset + 1}-${params.offset + showing} of ${total} total row(s).`,
    ];
    if (hasMore) {
      lines.push(
        `More rows available. Use offset: ${params.offset + showing} to see next page.`
      );
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool: kb_table_stats
// ---------------------------------------------------------------------------

const TableStatsInputSchema = z
  .object({
    table: z
      .string()
      .min(1, "Table name is required")
      .describe("Table name to get statistics for"),
    schema: z
      .string()
      .optional()
      .describe("Schema name (default: from DB_SCHEMA env or 'public')"),
  })
  .strict();

registerToolWithMetadata(server, "kb_table_stats", {
  title: "Table Statistics",
  description: `Get storage and usage statistics for a table, including row count, size, and dead tuples.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  Table size, row count, index size, dead tuples, and last vacuum/analyze times.`,
  inputSchema: TableStatsInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async (params) => {
  try {
    const schema = params.schema || getDefaultSchema();

    const result = await executeQuery(
      `
      SELECT
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
        pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
        c.reltuples::bigint AS estimated_rows,
        s.n_live_tup AS live_rows,
        s.n_dead_tup AS dead_rows,
        s.last_vacuum,
        s.last_autovacuum,
        s.last_analyze,
        s.last_autoanalyze
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = $1
        AND c.relname = $2
      `,
      [schema, params.table]
    );

    if (result.rows.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `Table '${schema}.${params.table}' not found.`,
        }],
      };
    }

    const row = result.rows[0];
    const lines = [
      `# Statistics: ${schema}.${params.table}`,
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Size | ${row.total_size} |`,
      `| Table Size | ${row.table_size} |`,
      `| Index Size | ${row.index_size} |`,
      `| Estimated Rows | ${row.estimated_rows} |`,
      `| Live Rows | ${row.live_rows ?? "N/A"} |`,
      `| Dead Rows | ${row.dead_rows ?? "N/A"} |`,
      `| Last Vacuum | ${row.last_vacuum ?? "Never"} |`,
      `| Last Auto Vacuum | ${row.last_autovacuum ?? "Never"} |`,
      `| Last Analyze | ${row.last_analyze ?? "Never"} |`,
      `| Last Auto Analyze | ${row.last_autoanalyze ?? "Never"} |`,
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: handleDbError(error) }],
    };
  }
});

} // end registerTools

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate required environment
  if (!process.env.DB_HOST && !process.env.DB_PASSWORD) {
    console.error(
      "WARNING: No DB_HOST or DB_PASSWORD set. Using defaults (localhost). " +
        "Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME environment variables."
    );
  }

  pool = createPool();

  // Verify connection
  try {
    const client = await pool.connect();
    const versionResult = await client.query("SELECT version()");
    console.error(
      `Connected to database: ${versionResult.rows[0].version.substring(0, 80)}`
    );
    console.error(`Access mode: ${getAccessMode()}`);
    client.release();
  } catch (error) {
    console.error(
      `Failed to connect to database: ${error instanceof Error ? error.message : error}`
    );
    console.error(
      "Please check your DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME environment variables."
    );
    process.exit(1);
  }

  const transportMode = (process.env.TRANSPORT || "stdio").toLowerCase();

  if (transportMode === "http") {
    await startHttpServer();
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("KingBase MCP Server running via stdio");
  }
}

// ---------------------------------------------------------------------------
// Session Management (HTTP mode)
// ---------------------------------------------------------------------------

interface SessionInfo {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: Date;
  lastActivityAt: Date;
  requestCount: number;
}

const SESSION_TIMEOUT_MS = parseInt(
  process.env.SESSION_TIMEOUT_MS || "1800000",
  10
); // 30 minutes
const MAX_SESSIONS = parseInt(
  process.env.MAX_SESSIONS || "100",
  10
); // 100 concurrent sessions
const SESSION_CLEANUP_INTERVAL_MS = parseInt(
  process.env.SESSION_CLEANUP_INTERVAL_MS || "60000",
  10
); // 1 minute
const ENABLE_SESSION_DEBUG = process.env.ENABLE_SESSION_DEBUG === "true";

function logSession(event: string, sessionId?: string, extra?: string): void {
  const timestamp = new Date().toISOString();
  let msg = `[${timestamp}] SESSION:${event}`;
  if (sessionId) {
    msg += ` ${sessionId}`;
  }
  if (extra) {
    msg += ` ${extra}`;
  }
  console.error(msg);
}

function logSessionStats(sessions: Map<string, SessionInfo>): void {
  const now = Date.now();
  const stats = Array.from(sessions.values()).map((s) => ({
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
    requestCount: s.requestCount,
    idleMs: now - s.lastActivityAt.getTime(),
  }));
  console.error(
    `SESSION:STATS active=${sessions.size} sessions=${JSON.stringify(stats)}`
  );
}

function getSessionIdFromHeaders(req: Request): string | undefined {
  // Express automatically lowercases header names
  return req.headers["mcp-session-id"] as string | undefined;
}

function touchSession(session: SessionInfo): void {
  session.lastActivityAt = new Date();
  session.requestCount++;
}

function canCreateSession(sessions: Map<string, SessionInfo>): boolean {
  return sessions.size < MAX_SESSIONS;
}

async function cleanupStaleSessions(
  sessions: Map<string, SessionInfo>
): Promise<void> {
  const now = Date.now();
  const staleIds: string[] = [];

  for (const [id, session] of sessions) {
    const idleMs = now - session.lastActivityAt.getTime();
    if (idleMs > SESSION_TIMEOUT_MS) {
      staleIds.push(id);
    }
  }

  for (const id of staleIds) {
    const session = sessions.get(id)!;
    logSession("CLEANUP:TIMEOUT", id, `idle ${now - session.lastActivityAt.getTime()}ms`);
    try {
      await session.transport.close();
    } catch (err) {
      console.error(`Error closing stale session ${id}:`, err);
    }
    sessions.delete(id);
  }

  if (ENABLE_SESSION_DEBUG) {
    logSessionStats(sessions);
  }
}

async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Map to track active sessions for monitoring and timeout management
  // Session ID -> SessionInfo (with timestamps and request counts)
  const activeSessions = new Map<string, SessionInfo>();


  // Create a SINGLE shared transport that handles multiple sessions
  // The transport internally routes requests to appropriate sessions based on mcp-session-id header
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessionclosed: (sessionId: string) => {
      logSession("CLOSED", sessionId);
      activeSessions.delete(sessionId);
    },
  });

  // Create a SINGLE shared server instance for all sessions
  const server = createServer();
  await server.connect(transport);

  // Start periodic cleanup timer for session timeout enforcement
  const cleanupTimer = setInterval(() => {
    cleanupStaleSessions(activeSessions);
  }, SESSION_CLEANUP_INTERVAL_MS);

  console.error(
    `SESSION:INIT cleanup interval=${SESSION_CLEANUP_INTERVAL_MS}ms timeout=${SESSION_TIMEOUT_MS}ms max=${MAX_SESSIONS}`
  );

  // POST /mcp — handle JSON-RPC requests (including initialize and regular requests)
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionIdFromHeaders(req);
    const body = req.body;
    const isInit = isInitializeRequest(body);

    // For new initialize requests without a session ID,  check capacity
    if (isInit && !sessionId) {
      if (activeSessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Server capacity reached (${MAX_SESSIONS} concurrent sessions). Try again later.`,
          },
          id: null,
        });
        logSession("ERROR:CAPACITY");
        return;
      }
    }

    // Track activity for existing sessions (for timeout monitoring)
    if (sessionId && activeSessions.has(sessionId)) {
      touchSession(activeSessions.get(sessionId)!);
    }

    // Pass ALL requests to the shared transport - it handles session validation
    try {
      await transport.handleRequest(req, res, body);

      // After response, track any newly initialized sessions from response headers
      const responseSessionId = res.getHeader("mcp-session-id") as string | undefined;
      if (responseSessionId && !activeSessions.has(responseSessionId)) {
        logSession("INITIALIZED", responseSessionId);
        activeSessions.set(responseSessionId, {
          transport: null as any,
          server: null as any,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          requestCount: 1,
        });
      }
    } catch (error) {
      console.error("Error handling request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionIdFromHeaders(req);

    // Track activity for existing sessions
    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId)!;
      touchSession(session);
      if (ENABLE_SESSION_DEBUG) {
        logSession("SSE", sessionId);
      }
    }

    // All GET requests go through the shared transport
    // The transport handles session ID validation internally
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling SSE request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // DELETE /mcp — terminate session
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = getSessionIdFromHeaders(req);

    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId)!;
      touchSession(session);
      logSession("CLOSING", sessionId);
    } else if (sessionId) {
      logSession("ERROR:NOT_FOUND_DELETE", sessionId);
    }

    // All DELETE requests go through the shared transport
    // The transport will invoke onsessionclosed callback when session is closed
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling DELETE request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /health — health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      activeSessions: activeSessions.size,
      maxSessions: MAX_SESSIONS,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /sessions — session debug info (only in debug mode)
  app.get("/sessions", (req: Request, res: Response) => {
    if (!ENABLE_SESSION_DEBUG) {
      res.status(403).json({
        error: "Session debug endpoint disabled. Set ENABLE_SESSION_DEBUG=true",
      });
      return;
    }

    const now = Date.now();
    const sessionList = Array.from(activeSessions.entries()).map(
      ([id, session]) => ({
        id,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        requestCount: session.requestCount,
        idleMs: now - session.lastActivityAt.getTime(),
        willTimeoutIn: Math.max(
          0,
          SESSION_TIMEOUT_MS - (now - session.lastActivityAt.getTime())
        ),
      })
    );

    res.status(200).json({
      activeSessions: activeSessions.size,
      maxSessions: MAX_SESSIONS,
      cleanupIntervalMs: SESSION_CLEANUP_INTERVAL_MS,
      timeoutMs: SESSION_TIMEOUT_MS,
      sessions: sessionList,
    });
  });

  // GET /tools — list all available tools
  app.get("/tools", (req: Request, res: Response) => {
    const tools = Array.from(TOOL_REGISTRY.values()).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description.split("\n")[0], // First line only for summary
      annotations: tool.annotations,
    }));

    res.status(200).json({
      count: tools.length,
      tools,
    });
  });

  // GET /tools/:toolName — get detailed tool information
  app.get("/tools/:toolName", (req: Request, res: Response) => {
    const toolName = Array.isArray(req.params.toolName)
      ? req.params.toolName[0]
      : req.params.toolName;
    const tool = TOOL_REGISTRY.get(toolName);

    if (!tool) {
      res.status(404).json({
        error: "Tool not found",
        availableTools: Array.from(TOOL_REGISTRY.keys()),
      });
      return;
    }

    res.status(200).json(toolMetadataToJson(tool));
  });

  const host = process.env.MCP_HOST || "0.0.0.0";
  const port = parseInt(process.env.MCP_PORT || "3000", 10);

  const httpServer = app.listen(port, host, () => {
    console.error(`KingBase MCP Server running via HTTP at http://${host}:${port}/mcp`);
    console.error(`Health check: http://${host}:${port}/health`);
    console.error(`Tool discovery: http://${host}:${port}/tools`);
    if (ENABLE_SESSION_DEBUG) {
      console.error(`Session debug: http://${host}:${port}/sessions`);
    }
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.error("\nSHUTDOWN: Received SIGINT");
    clearInterval(cleanupTimer);
    console.error("SHUTDOWN: Stopped cleanup timer");

    // Close the shared transport (which will close all active sessions)
    const sessionIds = Array.from(activeSessions.keys());
    console.error(
      `SHUTDOWN:CLOSING ${sessionIds.length} session(s): ${sessionIds.join(", ")}`
    );

    try {
      await transport.close();
      console.error("SHUTDOWN: Transport closed");
    } catch (err) {
      console.error("Error closing transport:", err);
    }

    activeSessions.clear();
    console.error("SHUTDOWN: All sessions cleared");

    httpServer.close(() => {
      console.error("SHUTDOWN: HTTP server stopped");
      pool.end().then(() => {
        console.error("SHUTDOWN: Database pool ended");
        process.exit(0);
      });
    });
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
