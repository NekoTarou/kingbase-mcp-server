#!/usr/bin/env tsx
/**
 * Documentation Generator for KingBase MCP Server
 *
 * Parses src/index.ts to extract tool metadata and generates TOOLS.md documentation
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.join(__dirname, "../src/index.ts");
const outputFile = path.join(__dirname, "../TOOLS.md");

interface ToolInfo {
  name: string;
  title: string;
  description: string;
  inputSchema: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  category: "Read-Only" | "Write";
}

/**
 * Parse tool registrations from src/index.ts
 */
function parseTools(): ToolInfo[] {
  const content = fs.readFileSync(srcFile, "utf-8");

  // Pattern to match: registerToolWithMetadata(server, "name", { title: "...", description: `...`, ... })
  // Matches both old and new patterns for backwards compatibility
  const toolPattern =
    /(?:server\.registerTool|registerToolWithMetadata\(server,)\s*"([^"]+)",\s*\{[\s\S]*?title:\s*"([^"]+)",\s*description:\s*`([^`]+)`,[\s\S]*?inputSchema:\s*(\w+),\s*annotations:\s*\{[\s\S]*?readOnlyHint:\s*(true|false),[\s\S]*?destructiveHint:\s*(true|false),[\s\S]*?idempotentHint:\s*(true|false),[\s\S]*?openWorldHint:\s*(true|false),[\s\S]*?\}/gi;

  const tools: ToolInfo[] = [];
  let match;

  while ((match = toolPattern.exec(content)) !== null) {
    const [, name, title, description, schema, readOnly, destructive, idempotent, openWorld] = match;

    const tool: ToolInfo = {
      name,
      title,
      description: description.trim(),
      inputSchema: schema,
      readOnly: readOnly === "true",
      destructive: destructive === "true",
      idempotent: idempotent === "true",
      openWorld: openWorld === "true",
      category: readOnly === "true" ? "Read-Only" : "Write",
    };

    tools.push(tool);
  }

  return tools;
}

/**
 * Parse schema definition from source
 */
function getSchemaFields(schemaName: string): { name: string; type: string; required: boolean; description: string }[] {
  const content = fs.readFileSync(srcFile, "utf-8");

  // Find the schema definition: const SchemaName = z.object({ ... }).strict();
  const schemaPattern = new RegExp(
    `const\\s+${schemaName}\\s*=\\s*z\\.object\\(\\{([^}]+)\\}\\.\\*strict\\(\\)`,
    "s"
  );

  const match = content.match(schemaPattern);
  if (!match) return [];

  const schemaBody = match[1];
  const fields: { name: string; type: string; required: boolean; description: string }[] = [];

  // Parse individual fields: fieldName: z.string().describe("description")
  const fieldPattern =
    /(\w+):\s*z\.(string|number|boolean|array|union)\([^)]*\)(?:\.([^.]+)\([^)]*\))*\.describe\("([^"]+)"\)/g;

  let fieldMatch;
  while ((fieldMatch = fieldPattern.exec(schemaBody)) !== null) {
    const [, fieldName, fieldType, , description] = fieldMatch;

    fields.push({
      name: fieldName,
      type: fieldType,
      required: !schemaBody.includes(`${fieldName}:`),
      description,
    });
  }

  return fields;
}

/**
 * Generate markdown documentation
 */
function generateMarkdown(tools: ToolInfo[]): string {
  const readOnlyTools = tools.filter((t) => t.category === "Read-Only");
  const writeTools = tools.filter((t) => t.category === "Write");

  let markdown = `# KingBase MCP Server - Tool Reference

This is the auto-generated reference for all available tools in the KingBase MCP Server.

## Table of Contents

- [Read-Only Tools](#read-only-tools) (${readOnlyTools.length} tools)
- [Write Tools](#write-tools) (${writeTools.length} tools)

## Overview

**Total Tools**: ${tools.length}

The KingBase MCP Server exposes database tools in two categories:
- **Read-Only Tools**: Safe to use in any context, no data modification
- **Write Tools**: Modify database state, require proper access permissions

---

## Read-Only Tools

Read-only tools are safe for querying and inspecting the database without making changes.

`;

  for (const tool of readOnlyTools) {
    markdown += generateToolSection(tool);
  }

  markdown += `---

## Write Tools

Write tools modify database state and require appropriate access permissions via the \`ACCESS_MODE\` environment variable.

`;

  for (const tool of writeTools) {
    markdown += generateToolSection(tool);
  }

  markdown += `---

## Environment Variables

Configure these environment variables to control access and behavior:

### Database Connection
- \`DB_HOST\` (default: \`localhost\`) - Database host
- \`DB_PORT\` (default: \`54321\`) - Database port
- \`DB_USER\` (default: \`system\`) - Database user
- \`DB_PASSWORD\` - Database password (required)
- \`DB_NAME\` (default: \`kingbase\`) - Database name
- \`DB_SCHEMA\` (default: \`public\`) - Default schema for table operations

### Access Control
- \`ACCESS_MODE\` (default: \`readonly\`) - Permission level
  - \`readonly\` - Only read-only tools
  - \`readwrite\` - readonly + INSERT/UPDATE
  - \`full\` - readwrite + DELETE
  - \`admin\` - full + DDL operations

### HTTP Transport (when \`TRANSPORT=http\`)
- \`TRANSPORT\` (default: \`stdio\`) - Set to \`http\` for HTTP transport mode
- \`MCP_HOST\` (default: \`0.0.0.0\`) - HTTP server bind address
- \`MCP_PORT\` (default: \`3000\`) - HTTP server port

---

## API Endpoints (HTTP Mode)

When running in HTTP mode (\`TRANSPORT=http\`), these endpoints are available:

### Health Check
\`\`\`
GET /health
\`\`\`

Returns server health status and active session count.

### Tool Discovery
\`\`\`
GET /tools
\`\`\`

List all available tools with summary information.

\`\`\`
GET /tools/{toolName}
\`\`\`

Get detailed information about a specific tool, including full JSON schema.

### MCP Protocol Endpoint
\`\`\`
POST /mcp
PUT /mcp
DELETE /mcp
\`\`\`

MCP protocol endpoints for tool invocation.

---

## Notes

- All SQL parameters use PostgreSQL parameterized query syntax (\`$1\`, \`$2\`, etc.)
- Table names without schema prefix are automatically qualified with the configured schema
- Two-phase confirmation is required for DML (\`kb_execute\`) and DDL (\`kb_execute_ddl\`) operations
- Output is truncated at 50,000 characters
`;

  return markdown;
}

/**
 * Generate markdown section for a single tool
 */
function generateToolSection(tool: ToolInfo): string {
  const categoryEmoji = tool.readOnly ? "🔒" : "✏️";
  const destructiveEmoji = tool.destructive ? "⚠️" : "✓";

  let section = `### ${categoryEmoji} ${tool.name}

**Title**: ${tool.title}

**Description**:
${tool.description
  .split("\n")
  .map((line) => line)
  .join("\n")}

**Annotations**:
- Read-Only: ${tool.readOnly ? "✓" : "✗"}
- Destructive: ${tool.destructive ? "✓" : "✗"}
- Idempotent: ${tool.idempotent ? "✓" : "✗"}
- Open World: ${tool.openWorld ? "✓" : "✗"}

`;

  return section;
}

/**
 * Main execution
 */
function main() {
  console.error("🔍 Parsing tools from src/index.ts...");

  try {
    const tools = parseTools();

    if (tools.length === 0) {
      console.error("❌ No tools found in src/index.ts");
      process.exit(1);
    }

    console.error(`✓ Found ${tools.length} tools`);

    const markdown = generateMarkdown(tools);

    fs.writeFileSync(outputFile, markdown, "utf-8");
    console.error(`✓ Documentation generated: ${outputFile}`);

    // Print summary
    const readOnlyCount = tools.filter((t) => t.readOnly).length;
    const writeCount = tools.filter((t) => !t.readOnly).length;

    console.error(`\nSummary:`);
    console.error(`  Read-Only Tools: ${readOnlyCount}`);
    console.error(`  Write Tools: ${writeCount}`);
    console.error(`  Total: ${tools.length}`);
  } catch (error) {
    console.error("❌ Error generating documentation:");
    console.error(error);
    process.exit(1);
  }
}

main();
