import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CHARACTER_LIMIT,
  classifyDML,
  formatRows,
  getAccessMode,
  getDefaultSchema,
  handleDbError,
  hasAccess,
  isDangerousDDL,
  isReadOnly,
  qualifyTableNames,
} from "../src/utils.js";

// ---------------------------------------------------------------------------
// isReadOnly
// ---------------------------------------------------------------------------

describe("isReadOnly", () => {
  it("returns true for SELECT", () => {
    expect(isReadOnly("SELECT * FROM users")).toBe(true);
  });

  it("returns true for select (case-insensitive)", () => {
    expect(isReadOnly("select id from users")).toBe(true);
  });

  it("returns true for WITH (CTE)", () => {
    expect(isReadOnly("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  it("returns true for EXPLAIN", () => {
    expect(isReadOnly("EXPLAIN SELECT * FROM users")).toBe(true);
  });

  it("returns true for SHOW", () => {
    expect(isReadOnly("SHOW search_path")).toBe(true);
  });

  it("returns true with leading whitespace", () => {
    expect(isReadOnly("  SELECT 1")).toBe(true);
  });

  it("returns false for INSERT", () => {
    expect(isReadOnly("INSERT INTO users (name) VALUES ('a')")).toBe(false);
  });

  it("returns false for UPDATE", () => {
    expect(isReadOnly("UPDATE users SET name = 'b'")).toBe(false);
  });

  it("returns false for DELETE", () => {
    expect(isReadOnly("DELETE FROM users")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReadOnly("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyDML
// ---------------------------------------------------------------------------

describe("classifyDML", () => {
  it("classifies INSERT", () => {
    expect(classifyDML("INSERT INTO users VALUES (1)")).toBe("INSERT");
  });

  it("classifies UPDATE", () => {
    expect(classifyDML("UPDATE users SET name = 'x'")).toBe("UPDATE");
  });

  it("classifies DELETE", () => {
    expect(classifyDML("DELETE FROM users WHERE id = 1")).toBe("DELETE");
  });

  it("classifies SELECT as OTHER", () => {
    expect(classifyDML("SELECT 1")).toBe("OTHER");
  });

  it("is case-insensitive", () => {
    expect(classifyDML("insert into t values (1)")).toBe("INSERT");
  });

  it("returns OTHER for empty string", () => {
    expect(classifyDML("")).toBe("OTHER");
  });
});

// ---------------------------------------------------------------------------
// isDangerousDDL
// ---------------------------------------------------------------------------

describe("isDangerousDDL", () => {
  it("detects DROP TABLE", () => {
    expect(isDangerousDDL("DROP TABLE users")).toBe(true);
  });

  it("detects TRUNCATE", () => {
    expect(isDangerousDDL("TRUNCATE TABLE users")).toBe(true);
  });

  it("detects CASCADE anywhere in statement", () => {
    expect(isDangerousDDL("ALTER TABLE users DROP COLUMN name CASCADE")).toBe(
      true
    );
  });

  it("returns false for CREATE TABLE", () => {
    expect(isDangerousDDL("CREATE TABLE test (id INT)")).toBe(false);
  });

  it("returns false for ALTER TABLE (non-cascade)", () => {
    expect(isDangerousDDL("ALTER TABLE users ADD COLUMN email TEXT")).toBe(
      false
    );
  });

  it("returns false for empty string", () => {
    expect(isDangerousDDL("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatRows
// ---------------------------------------------------------------------------

describe("formatRows", () => {
  it("returns message for empty array", () => {
    expect(formatRows([])).toBe("No rows returned.");
  });

  it("formats a single row", () => {
    const result = formatRows([{ id: 1, name: "Alice" }]);
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("1");
    expect(result).toContain("Alice");
    // Should have header, separator, and one data line
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
  });

  it("formats multiple rows", () => {
    const rows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const result = formatRows(rows);
    const lines = result.split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 data rows
  });

  it("handles NULL values", () => {
    const result = formatRows([{ id: 1, name: null }]);
    expect(result).toContain("NULL");
  });

  it("truncates output exceeding CHARACTER_LIMIT", () => {
    // Create enough rows to exceed 50k characters
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      data: "x".repeat(50),
    }));
    const result = formatRows(rows);
    expect(result).toContain("Output truncated");
    expect(result.length).toBeGreaterThan(CHARACTER_LIMIT);
    expect(result.length).toBeLessThan(CHARACTER_LIMIT + 200);
  });
});

// ---------------------------------------------------------------------------
// handleDbError
// ---------------------------------------------------------------------------

describe("handleDbError", () => {
  it("formats a basic Error", () => {
    const result = handleDbError(new Error("connection refused"));
    expect(result).toBe("Error: connection refused");
  });

  it("includes pg error fields when present", () => {
    const err = new Error("syntax error") as any;
    err.detail = "near 'SELCT'";
    err.hint = "Check spelling";
    err.position = "7";
    err.code = "42601";
    const result = handleDbError(err);
    expect(result).toContain("Error: syntax error");
    expect(result).toContain("Detail: near 'SELCT'");
    expect(result).toContain("Hint: Check spelling");
    expect(result).toContain("Position: 7");
    expect(result).toContain("Code: 42601");
  });

  it("handles string errors", () => {
    const result = handleDbError("something went wrong");
    expect(result).toBe("Error: something went wrong");
  });

  it("handles partial pg error fields", () => {
    const err = new Error("timeout") as any;
    err.code = "57014";
    const result = handleDbError(err);
    expect(result).toContain("Error: timeout");
    expect(result).toContain("Code: 57014");
    expect(result).not.toContain("Detail:");
    expect(result).not.toContain("Hint:");
  });
});

// ---------------------------------------------------------------------------
// qualifyTableNames
// ---------------------------------------------------------------------------

describe("qualifyTableNames", () => {
  it("qualifies simple FROM table", () => {
    expect(qualifyTableNames("SELECT * FROM users", "myschema")).toBe(
      "SELECT * FROM myschema.users"
    );
  });

  it("does not double-qualify already qualified table", () => {
    const sql = "SELECT * FROM public.users";
    expect(qualifyTableNames(sql, "myschema")).toBe(sql);
  });

  it("qualifies JOIN tables", () => {
    const result = qualifyTableNames(
      "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
      "s"
    );
    expect(result).toContain("FROM s.users");
    expect(result).toContain("JOIN s.orders");
  });

  it("qualifies INSERT INTO table", () => {
    const result = qualifyTableNames(
      "INSERT INTO users (name) VALUES ('a')",
      "s"
    );
    expect(result).toContain("INTO s.users");
  });

  it("qualifies UPDATE table", () => {
    const result = qualifyTableNames("UPDATE users SET name = 'b'", "s");
    expect(result).toContain("UPDATE s.users");
  });

  it("is case-insensitive for keywords", () => {
    const result = qualifyTableNames("select * from users", "s");
    expect(result).toContain("s.users");
  });
});

// ---------------------------------------------------------------------------
// getAccessMode
// ---------------------------------------------------------------------------

describe("getAccessMode", () => {
  const originalEnv = process.env.ACCESS_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ACCESS_MODE;
    } else {
      process.env.ACCESS_MODE = originalEnv;
    }
  });

  it("returns 'readonly' by default", () => {
    delete process.env.ACCESS_MODE;
    expect(getAccessMode()).toBe("readonly");
  });

  it("returns 'readwrite' when set", () => {
    process.env.ACCESS_MODE = "readwrite";
    expect(getAccessMode()).toBe("readwrite");
  });

  it("returns 'admin' when set", () => {
    process.env.ACCESS_MODE = "admin";
    expect(getAccessMode()).toBe("admin");
  });

  it("falls back to 'readonly' for invalid value", () => {
    process.env.ACCESS_MODE = "superadmin";
    expect(getAccessMode()).toBe("readonly");
  });

  it("is case-insensitive", () => {
    process.env.ACCESS_MODE = "ReadWrite";
    expect(getAccessMode()).toBe("readwrite");
  });
});

// ---------------------------------------------------------------------------
// hasAccess
// ---------------------------------------------------------------------------

describe("hasAccess", () => {
  const originalEnv = process.env.ACCESS_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ACCESS_MODE;
    } else {
      process.env.ACCESS_MODE = originalEnv;
    }
  });

  it("readonly allows readonly", () => {
    process.env.ACCESS_MODE = "readonly";
    expect(hasAccess("readonly")).toBe(true);
  });

  it("readonly denies readwrite", () => {
    process.env.ACCESS_MODE = "readonly";
    expect(hasAccess("readwrite")).toBe(false);
  });

  it("admin allows everything", () => {
    process.env.ACCESS_MODE = "admin";
    expect(hasAccess("readonly")).toBe(true);
    expect(hasAccess("readwrite")).toBe(true);
    expect(hasAccess("full")).toBe(true);
    expect(hasAccess("admin")).toBe(true);
  });

  it("full allows readwrite but denies admin", () => {
    process.env.ACCESS_MODE = "full";
    expect(hasAccess("readwrite")).toBe(true);
    expect(hasAccess("admin")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDefaultSchema
// ---------------------------------------------------------------------------

describe("getDefaultSchema", () => {
  const originalEnv = process.env.DB_SCHEMA;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DB_SCHEMA;
    } else {
      process.env.DB_SCHEMA = originalEnv;
    }
  });

  it("returns 'public' by default", () => {
    delete process.env.DB_SCHEMA;
    expect(getDefaultSchema()).toBe("public");
  });

  it("returns custom schema when set", () => {
    process.env.DB_SCHEMA = "myapp";
    expect(getDefaultSchema()).toBe("myapp");
  });

  it("returns 'public' when env is empty string", () => {
    process.env.DB_SCHEMA = "";
    expect(getDefaultSchema()).toBe("public");
  });
});
