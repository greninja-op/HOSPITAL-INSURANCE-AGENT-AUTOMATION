import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Smoke / architectural test for data-store portability.
 *
 * Validates: Requirements 39.1, 39.2
 *
 * The portability guarantee is structural: the Prisma schema declares exactly ONE
 * datasource, its connection URL always comes from `env("DATABASE_URL")`, and the
 * only thing that changes to move between SQLite and PostgreSQL is the datasource
 * `provider`. No model may rely on a provider-specific construct (raw native types,
 * `Unsupported(...)`, `dbgenerated(...)`, native-type attributes, or a hardcoded URL),
 * so switching `provider` + `DATABASE_URL` requires no application-code change.
 *
 * These assertions are deliberately structural (regex over the schema text) rather than
 * pinned to a specific provider value, since the project may run on either engine.
 */
describe("Prisma schema data-store portability (Req 39.1, 39.2)", () => {
  const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
  const schema = readFileSync(schemaPath, "utf8");

  // Isolate datasource block(s): `datasource <name> { ... }`
  const datasourceBlocks = schema.match(/datasource\s+\w+\s*\{[^}]*\}/g) ?? [];

  it("declares exactly one datasource block", () => {
    expect(datasourceBlocks).toHaveLength(1);
  });

  it("reads the connection URL from env(\"DATABASE_URL\") and never hardcodes it", () => {
    const block = datasourceBlocks[0] ?? "";
    // url must be sourced from the DATABASE_URL environment variable
    expect(block).toMatch(/url\s*=\s*env\(\s*"DATABASE_URL"\s*\)/);
    // guard against a hardcoded connection string literal for url
    expect(block).not.toMatch(/url\s*=\s*"(?!.*env)(sqlite|postgres|postgresql|mysql|file):/i);
  });

  it("uses a provider that is the single switch between SQLite and PostgreSQL", () => {
    const block = datasourceBlocks[0] ?? "";
    const providerMatch = block.match(/provider\s*=\s*"([^"]+)"/);
    expect(providerMatch).not.toBeNull();
    const provider = providerMatch![1];
    // provider is the only value that changes between the two supported engines
    expect(["sqlite", "postgresql"]).toContain(provider);
  });

  it("uses no provider-specific native type attributes (@db.*)", () => {
    // e.g. @db.Uuid, @db.VarChar, @db.JsonB — these bind a model to one engine.
    expect(schema).not.toMatch(/@db\./);
  });

  it("uses no Unsupported(...) columns", () => {
    // Unsupported types are inherently provider-specific and break portability.
    expect(schema).not.toMatch(/\bUnsupported\s*\(/);
  });

  it("uses no dbgenerated(...) / provider-specific default expressions", () => {
    expect(schema).not.toMatch(/\bdbgenerated\s*\(/);
  });

  it("declares no preview features or provider-specific extensions block", () => {
    // extensions (e.g. Postgres extensions) would not port to SQLite.
    expect(schema).not.toMatch(/\bextensions\s*=/);
  });

  it("uses Json fields in a portable way (plain `Json`, no native-type annotation)", () => {
    // Every Json field must be a bare `Json`/`Json?` with no trailing @db native type,
    // so the column maps transparently to TEXT (SQLite) or JSONB (Postgres).
    const jsonFieldLines = schema
      .split(/\r?\n/)
      .filter((line) => /^\s*\w+\s+Json\??/.test(line));

    // Sanity: the schema does actually exercise Json columns.
    expect(jsonFieldLines.length).toBeGreaterThan(0);

    for (const line of jsonFieldLines) {
      expect(line).not.toMatch(/@db\./);
    }
  });
});
