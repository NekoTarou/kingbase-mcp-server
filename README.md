# KingBase MCP Server

[![License](https://img.shields.io/github/license/NekoTarou/kingbase-mcp-server.svg)](https://github.com/NekoTarou/kingbase-mcp-server/blob/main/LICENSE)
[![Build & Test](https://github.com/NekoTarou/kingbase-mcp-server/actions/workflows/publish.yml/badge.svg)](https://github.com/NekoTarou/kingbase-mcp-server/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/kingbase-mcp-server.svg)](https://www.npmjs.com/package/kingbase-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/kingbase-mcp-server.svg)](https://www.npmjs.com/package/kingbase-mcp-server)
[![Node.js Version](https://img.shields.io/node/v/kingbase-mcp-server.svg)](https://nodejs.org)
[![MCP Badge](https://lobehub.com/badge/mcp/nekotarou-kingbase-mcp-server?style=plastic)](https://lobehub.com/mcp/nekotarou-kingbase-mcp-server)

[English](#english) | 中文

直连 [KingBase](https://www.kingbase.com.cn/)（PostgreSQL 兼容）数据库的 MCP Server，让 AI 助手（Claude 等）能够直接查询和管理 KingBase 数据库。

## 快速使用

无需克隆代码，直接在 MCP 客户端中配置即可使用：

```json
{
  "mcpServers": {
    "kingbase": {
      "command": "npx",
      "args": ["-y", "kingbase-mcp-server"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "54321",
        "DB_USER": "system",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "kingbase",
        "DB_SCHEMA": "public",
        "ACCESS_MODE": "readonly"
      }
    }
  }
}
```

也可以全局安装后使用：

```bash
npm install -g kingbase-mcp-server
kingbase-mcp-server
```

## 功能

| Tool                  | 说明                               | 类型 |
| --------------------- | ---------------------------------- | ---- |
| `kb_query`            | 执行只读查询 (SELECT/WITH/SHOW)    | 只读 |
| `kb_execute`          | 执行 DML (INSERT/UPDATE/DELETE)    | 读写 |
| `kb_execute_ddl`      | 执行 DDL (CREATE/ALTER/DROP)       | 读写 |
| `kb_list_schemas`     | 列出所有 schema                    | 只读 |
| `kb_list_tables`      | 列出表和视图                       | 只读 |
| `kb_describe_table`   | 查看表结构（列、类型、约束、注释） | 只读 |
| `kb_list_indexes`     | 查看索引信息                       | 只读 |
| `kb_list_constraints` | 查看约束信息                       | 只读 |
| `kb_explain`          | 查看执行计划 (EXPLAIN)             | 只读 |
| `kb_table_data`       | 预览表数据（带分页和过滤）         | 只读 |
| `kb_table_stats`      | 查看表统计信息（大小、行数等）     | 只读 |

### 提示词 (Prompts)

| Prompt               | 说明                                  |
| -------------------- | ------------------------------------- |
| `kb_query_prompt`    | 查询助手：描述需求，自动构造 SQL 查询 |
| `kb_schema_overview` | Schema 概览：获取数据库结构的全面分析 |

### 资源 (Resources)

| URI                 | 说明                                       |
| ------------------- | ------------------------------------------ |
| `kingbase://config` | 当前数据库连接配置（不含密码等敏感信息）   |
| `kingbase://status` | 服务器运行状态（版本、连接状态、运行时间） |

## 环境变量

| 变量           | 说明                         | 默认值      |
| -------------- | ---------------------------- | ----------- |
| `DB_HOST`      | 数据库主机                   | `localhost` |
| `DB_PORT`      | 数据库端口                   | `54321`     |
| `DB_USER`      | 用户名                       | `system`    |
| `DB_PASSWORD`  | 密码                         | (空)        |
| `DB_NAME`      | 数据库名                     | `kingbase`  |
| `DB_SCHEMA`    | 默认 schema                  | `public`    |
| `TRANSPORT`    | 传输模式：`stdio` 或 `http`  | `stdio`     |
| `MCP_PORT`     | HTTP 模式监听端口            | `3000`      |
| `MCP_HOST`     | HTTP 模式监听地址            | `0.0.0.0`   |
| `ACCESS_MODE`  | 权限模式（见下方说明）       | `readonly`  |
| `SKIP_CONFIRM` | 跳过写操作确认（见下方说明） | `false`     |

## 权限模式

通过 `ACCESS_MODE` 环境变量控制数据库操作权限，分为 4 个递增级别：

| 级别     | 值                 | 允许的操作                                              |
| -------- | ------------------ | ------------------------------------------------------- |
| 只读     | `readonly`（默认） | SELECT 查询、查看 schema/表结构/索引/约束/统计/执行计划 |
| 允许修改 | `readwrite`        | 只读 + INSERT / UPDATE                                  |
| 允许删除 | `full`             | 读写 + DELETE                                           |
| 管理员   | `admin`            | 完全权限 + DDL（CREATE / ALTER / DROP / TRUNCATE）      |

**默认为 `readonly`（只读模式）**，防止误操作。根据实际需要调整。

### 安全确认机制

`kb_execute`（DML）和 `kb_execute_ddl`（DDL）工具使用 MCP [Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) 机制进行用户确认：

- 当工具被调用时，服务端通过 elicitation 在协议层面**阻塞等待用户确认**
- 客户端会弹出确认对话框，用户必须明确点击确认/拒绝后操作才会继续
- AI 助手无法绕过此确认流程，确保数据安全

> ⚠️ **客户端不支持 Elicitation 时**：如果你的 MCP 客户端不支持 Elicitation（如旧版本客户端），写操作将**默认拒绝执行**并提示错误。如果你了解风险并希望跳过确认，可以设置环境变量 `SKIP_CONFIRM=true`。
>
> **⚠️ 警告：设置 `SKIP_CONFIRM=true` 将跳过所有 DML/DDL 操作的用户确认，AI 助手将直接执行写操作，请自行承担风险！**

### 配置示例

```bash
# 只读模式（默认，推荐用于日常查询）
ACCESS_MODE=readonly

# 允许增改（适用于数据维护）
ACCESS_MODE=readwrite

# 允许删除（适用于数据清理）
ACCESS_MODE=full

# 管理员模式（适用于 DDL 操作，如建表/改表）
ACCESS_MODE=admin
```

## 传输模式

### stdio 模式（默认）

适用于本地使用，客户端直接启动 MCP Server 进程。

### HTTP 模式

适用于远程部署，团队成员通过网络连接。使用 MCP Streamable HTTP 传输协议。

启动 HTTP 模式：

```bash
TRANSPORT='http' MCP_PORT='3000' DB_HOST='你的数据库地址' DB_PASSWORD='你的密码' node dist/index.js
# 或
npm run start:http
```

验证：

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## 在 Claude Code 中使用

### stdio 模式（推荐）

编辑 `~/.claude.json`，在对应的空间下添加，或者在当前目录中创建`.mcp.json`文件，添加如下内容：

```json
{
  "mcpServers": {
    "kingbase": {
      "command": "npx",
      "args": ["-y", "kingbase-mcp-server"],
      "env": {
        "DB_HOST": "你的数据库地址",
        "DB_PORT": "54321",
        "DB_USER": "system",
        "DB_PASSWORD": "你的密码",
        "DB_NAME": "数据库名",
        "DB_SCHEMA": "public",
        "ACCESS_MODE": "readonly"
      }
    }
  }
}
```

### HTTP 模式（远程连接）

在服务器上启动 HTTP 模式后，客户端配置：

```json
{
  "mcpServers": {
    "kingbase": {
      "url": "http://你的服务器地址:3000/mcp"
    }
  }
}
```

## 构建

```bash
npm install
npm run build
```

## 配置文件

项目支持 `.env` 配置文件，**避免在 shell 中直接传入含特殊字符的密码导致解析失败**。

```bash
# 复制模板
cp .env.example .env

# 编辑配置（密码中的特殊字符无需转义）
vi .env
```

`.env` 文件示例：

```
DB_HOST=192.168.1.100
DB_PORT=54321
DB_USER=system
DB_PASSWORD=P@ss(w0rd)!#$
DB_NAME=mydb
DB_SCHEMA=public
TRANSPORT=http
MCP_PORT=3000
ACCESS_MODE=readonly
```

配置好后直接启动即可，无需在命令行传递环境变量：

```bash
node dist/index.js
# 或
npm start
```

> `.env` 已在 `.gitignore` 中，不会被提交到仓库。命令行传入的环境变量优先级高于 `.env` 文件。

## 服务器部署（HTTP 模式）

### 1. 安装

```bash
# 方式一：npm 全局安装（推荐）
npm install -g kingbase-mcp-server

# 方式二：从源码安装
git clone https://github.com/NekoTarou/kingbase-mcp-server.git
cd kingbase-mcp-server
npm install
npm run build
```

### 2. 直接启动

```bash
TRANSPORT='http' \
MCP_PORT='3000' \
ACCESS_MODE='readonly' \
DB_HOST='192.168.1.100' \
DB_PORT='54321' \
DB_USER='system' \
DB_PASSWORD='your_password' \
DB_NAME='mydb' \
node dist/index.js
```

### 3. 使用 systemd 管理（推荐）

创建环境变量文件 `/etc/kingbase-mcp-server.env`：

```
TRANSPORT=http
MCP_PORT=3000
MCP_HOST=0.0.0.0
ACCESS_MODE=readonly
DB_HOST=192.168.1.100
DB_PORT=54321
DB_USER=system
DB_PASSWORD=your_password
DB_NAME=mydb
DB_SCHEMA=public
```

创建服务文件 `/etc/systemd/system/kingbase-mcp.service`：

```ini
[Unit]
Description=KingBase MCP Server
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/kingbase-mcp-server.env
WorkingDirectory=/opt/kingbase-mcp-server
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable kingbase-mcp
sudo systemctl start kingbase-mcp
sudo systemctl status kingbase-mcp   # 查看状态
sudo journalctl -u kingbase-mcp -f   # 查看日志
```

### 4. 验证

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

成功会返回 JSON 响应，response header 中包含 `mcp-session-id`。

### 5. 安全提示

当前未内置认证机制。如果服务暴露在公网，建议：

- 通过防火墙限制访问来源 IP
- 在前面加 nginx 反向代理 + 基础认证
- 后续可按需添加 OAuth 认证

---

<a id="english"></a>

## English

MCP (Model Context Protocol) server for [KingBase](https://www.kingbase.com.cn/) — a PostgreSQL-compatible enterprise database widely used in Chinese government and enterprise environments.

### Quick Start

```json
{
  "mcpServers": {
    "kingbase": {
      "command": "npx",
      "args": ["-y", "kingbase-mcp-server"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "54321",
        "DB_USER": "system",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "kingbase",
        "ACCESS_MODE": "readonly"
      }
    }
  }
}
```

### Features

- 11 database tools: query, DML, DDL, schema inspection, statistics
- 2 prompts: query helper, schema overview
- 2 resources: database config, server status
- Two transport modes: stdio (local) and Streamable HTTP (remote)
- Fine-grained access control: `readonly` / `readwrite` / `full` / `admin`
- Secure confirmation for write operations via MCP Elicitation (with two-phase fallback)
- Auto schema qualification for table names
- Parameterized queries for safe value substitution

See above sections for detailed documentation (in Chinese).

## License

[MIT](./LICENSE)
