# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server for KingBase, a PostgreSQL-compatible database. Exposes 11 database tools (query, DML, DDL, schema inspection, stats) over stdio and Streamable HTTP transports. Written in TypeScript as a single-file application (`src/index.ts`).

## Build & Run

```bash
npm install          # install dependencies
npm run build        # compile TypeScript (tsc → dist/)
npm run dev          # development with watch mode (tsx watch)
npm start            # run compiled server via stdio (node dist/index.js)
npm run start:http   # run compiled server via HTTP (TRANSPORT=http)
npm run clean        # remove dist/
```

No test framework or linter is configured.

## Architecture

The entire server lives in `src/index.ts` (~1085 lines), organized top-to-bottom:

1. **Constants** — `CHARACTER_LIMIT` (50k), `DEFAULT_ROW_LIMIT` (100), `MAX_ROW_LIMIT` (1000)
2. **Database layer** — `createPool()` returns a `pg.Pool` (max 5 connections, 30s idle, 10s connect timeout). `executeQuery()` acquires a client, runs the query, and releases.
3. **Helpers** — `formatRows()` renders ASCII tables with truncation; `handleDbError()` extracts pg error details; `isReadOnly()` / `isDangerousDDL()` classify SQL statements.
4. **`createServer()` / `registerTools()`** — Factory function that creates an `McpServer` instance and registers all tools. Called once for stdio, once per session for HTTP.
5. **Tool registrations** — Each tool has a Zod input schema, MCP annotations (`readOnlyHint`, `destructiveHint`, etc.), and an async handler. Tools:
   - **Read-only**: `kb_query`, `kb_list_schemas`, `kb_list_tables`, `kb_describe_table`, `kb_list_indexes`, `kb_list_constraints`, `kb_explain`, `kb_table_data`, `kb_table_stats`
   - **Write**: `kb_execute` (DML), `kb_execute_ddl` (DDL)
6. **Main** — Validates env, verifies DB connection, branches by `TRANSPORT` env var
7. **`startHttpServer()`** — Express app with `/mcp` endpoint, stateful sessions via `StreamableHTTPServerTransport`

## Key Patterns

- All DB config comes from environment variables: `DB_HOST` (default: localhost), `DB_PORT` (default: 54321), `DB_USER` (default: system), `DB_PASSWORD`, `DB_NAME` (default: kingbase), `DB_SCHEMA` (default: public)
- Transport mode selected via `TRANSPORT` env var: `stdio` (default) or `http`. HTTP mode also uses `MCP_PORT` (default: 3000) and `MCP_HOST` (default: 0.0.0.0)
- Access mode controlled via `ACCESS_MODE` env var (default: `readonly`):
  - `readonly` — only read-only tools (query, list, describe, stats, explain)
  - `readwrite` — readonly + INSERT/UPDATE via kb_execute
  - `full` — readwrite + DELETE via kb_execute
  - `admin` — full + DDL via kb_execute_ddl
- DML (`kb_execute`) and DDL (`kb_execute_ddl`) require two-phase confirmation: first call returns a preview, second call with `confirmed: true` executes
- Tool input schemas use Zod with `.strict()` to reject extra fields
- `pg` is imported as a default ESM import (`import pg from "pg"`) then destructured (`const { Pool } = pg`) due to ESM/CJS interop
- The `schema` parameter on most tools falls back to `getDefaultSchema()` → `DB_SCHEMA` env → `"public"`
- Diagnostic output goes to stderr (since stdout is the MCP stdio transport)
- Output is truncated at 50k characters with a user-facing message

## Tech Stack

- TypeScript 5.7+ with strict mode, targeting ES2022 / Node16 module system
- `@modelcontextprotocol/sdk` ^1.6.1 — MCP server framework (stdio + Streamable HTTP)
- `express` ^5.2 — HTTP framework (for HTTP transport mode)
- `pg` ^8.13 — PostgreSQL driver (compatible with KingBase)
- `zod` ^3.23 — input validation
- Node.js >= 18

## Integration

### stdio mode (default)

Configure in `~/.claude/settings.json` as an MCP server:
```json
{
  "mcpServers": {
    "kingbase": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"],
      "env": {
        "DB_HOST": "...", "DB_PORT": "54321", "DB_USER": "system",
        "DB_PASSWORD": "...", "DB_NAME": "...", "DB_SCHEMA": "public",
        "ACCESS_MODE": "readonly"
      }
    }
  }
}
```

### HTTP mode (remote)

Start: `TRANSPORT=http MCP_PORT=3000 ACCESS_MODE=readonly DB_HOST=... DB_PASSWORD=... node dist/index.js`

Client config:
```json
{
  "mcpServers": {
    "kingbase": {
      "url": "http://<server-host>:3000/mcp"
    }
  }
}
```

The package also declares a `bin` entry (`kingbase-mcp-server`) for global/npx usage.
