# KingBase MCP Server - Tool Reference

This is the auto-generated reference for all available tools in the KingBase MCP Server.

## Table of Contents

- [Read-Only Tools](#read-only-tools) (8 tools)
- [Write Tools](#write-tools) (3 tools)

## Overview

**Total Tools**: 11

The KingBase MCP Server exposes database tools in two categories:
- **Read-Only Tools**: Safe to use in any context, no data modification
- **Write Tools**: Modify database state, require proper access permissions

---

## Read-Only Tools

Read-only tools are safe for querying and inspecting the database without making changes.

### 🔒 kb_query

**Title**: Execute Query

**Description**:
Execute a read-only SQL query (SELECT/WITH/SHOW) against the KingBase database.

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
  - sql: "SELECT * FROM public.sys_user" (explicit schema, not auto-qualified)

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_list_schemas

**Title**: List Schemas

**Description**:
List all schemas in the KingBase database.

Returns schema names excluding internal PostgreSQL/KingBase system schemas.

Args: None

Returns:
  List of schema names with their owners.

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_list_tables

**Title**: List Tables

**Description**:
List all tables and/or views in a schema.

Args:
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'
  - type ('table' | 'view' | 'all'): Filter by type (default: 'all')

Returns:
  List of tables/views with their type, owner, and estimated row count.

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_describe_table

**Title**: Describe Table

**Description**:
Get detailed structure of a table or view, including columns, types, constraints, and comments.

Args:
  - table (string): Table or view name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  Table structure with column names, data types, nullable, defaults, and comments.

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_list_indexes

**Title**: List Indexes

**Description**:
List all indexes on a table including columns, uniqueness, and index type.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  List of indexes with name, columns, uniqueness, and method (btree/hash/gin/gist).

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_list_constraints

**Title**: List Constraints

**Description**:
List all constraints (PK, FK, UNIQUE, CHECK) on a table.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  List of constraints with name, type, columns, and referenced table (for FK).

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_table_data

**Title**: Preview Table Data

**Description**:
Preview data from a table with optional filtering and pagination.

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
  - table: "orders", limit: 50, offset: 100

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

### 🔒 kb_table_stats

**Title**: Table Statistics

**Description**:
Get storage and usage statistics for a table, including row count, size, and dead tuples.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name, defaults to DB_SCHEMA env or 'public'

Returns:
  Table size, row count, index size, dead tuples, and last vacuum/analyze times.

**Annotations**:
- Read-Only: ✓
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

---

## Write Tools

Write tools modify database state and require appropriate access permissions via the `ACCESS_MODE` environment variable.

### ✏️ kb_execute

**Title**: Execute DML

**Description**:
Execute a DML statement (INSERT, UPDATE, DELETE) against the KingBase database.

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
  - sql: "DELETE FROM logs WHERE created_at < $1", params: ["2024-01-01"]

**Annotations**:
- Read-Only: ✗
- Destructive: ✓
- Idempotent: ✗
- Open World: ✗

### ✏️ kb_execute_ddl

**Title**: Execute DDL

**Description**:
Execute a DDL statement (CREATE, ALTER, DROP, TRUNCATE, etc.) against the KingBase database.

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
  - sql: "CREATE INDEX idx_users_email ON users(email)"

**Annotations**:
- Read-Only: ✗
- Destructive: ✓
- Idempotent: ✗
- Open World: ✗

### ✏️ kb_explain

**Title**: Explain Query

**Description**:
Get the execution plan for a SQL query using EXPLAIN.

Use this to analyze query performance, identify full table scans, and optimize queries.

Args:
  - sql (string): The SQL query to explain
  - analyze (boolean, default false): If true, actually executes the query (EXPLAIN ANALYZE) for real timing data
  - format ('text' | 'json' | 'yaml'): Output format (default: 'text')

Returns:
  Query execution plan showing scan types, costs, and join strategies.

Examples:
  - sql: "SELECT * FROM users WHERE email = 'test@example.com'"
  - sql: "SELECT u.*, o.* FROM users u JOIN orders o ON u.id = o.user_id", analyze: true

**Annotations**:
- Read-Only: ✗
- Destructive: ✗
- Idempotent: ✓
- Open World: ✗

---

## Environment Variables

Configure these environment variables to control access and behavior:

### Database Connection
- `DB_HOST` (default: `localhost`) - Database host
- `DB_PORT` (default: `54321`) - Database port
- `DB_USER` (default: `system`) - Database user
- `DB_PASSWORD` - Database password (required)
- `DB_NAME` (default: `kingbase`) - Database name
- `DB_SCHEMA` (default: `public`) - Default schema for table operations

### Access Control
- `ACCESS_MODE` (default: `readonly`) - Permission level
  - `readonly` - Only read-only tools
  - `readwrite` - readonly + INSERT/UPDATE
  - `full` - readwrite + DELETE
  - `admin` - full + DDL operations

### HTTP Transport (when `TRANSPORT=http`)
- `TRANSPORT` (default: `stdio`) - Set to `http` for HTTP transport mode
- `MCP_HOST` (default: `0.0.0.0`) - HTTP server bind address
- `MCP_PORT` (default: `3000`) - HTTP server port

---

## API Endpoints (HTTP Mode)

When running in HTTP mode (`TRANSPORT=http`), these endpoints are available:

### Health Check
```
GET /health
```

Returns server health status and active session count.

### Tool Discovery
```
GET /tools
```

List all available tools with summary information.

```
GET /tools/{toolName}
```

Get detailed information about a specific tool, including full JSON schema.

### MCP Protocol Endpoint
```
POST /mcp
PUT /mcp
DELETE /mcp
```

MCP protocol endpoints for tool invocation.

---

## Notes

- All SQL parameters use PostgreSQL parameterized query syntax (`$1`, `$2`, etc.)
- Table names without schema prefix are automatically qualified with the configured schema
- Two-phase confirmation is required for DML (`kb_execute`) and DDL (`kb_execute_ddl`) operations
- Output is truncated at 50,000 characters
