// =============================================================================
// lib/testDb.ts
//
// Test helper that provisions an isolated, throwaway PostgreSQL schema for tests.
//
// PostgreSQL has no file-based "temp database", so the portable equivalent is a
// uniquely-named schema inside the shared test database: each call creates a
// random schema (e.g. "test_ab12cd34"), applies the current Prisma schema to it
// via `prisma db push` (scoped to that schema through the connection URL), and
// returns a PrismaClient wired to it. Concurrent tests never see each other's
// rows. Call the returned `cleanup()` in `afterEach`/`afterAll` to drop the
// schema and disconnect.
//
// The base connection is read from TEST_DATABASE_URL (falling back to
// DATABASE_URL). Bring up the local instance with `docker compose up -d postgres`
// (postgresql://authpilot:authpilot@localhost:5433/authpilot).
// =============================================================================

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

export interface TestDb {
  /** PrismaClient bound to the isolated temporary schema. */
  prisma: PrismaClient;
  /** Full connection URL (including the `?schema=` override) for the test schema. */
  databaseUrl: string;
  /** Name of the throwaway PostgreSQL schema. */
  schema: string;
  /** Drop the schema and disconnect the client. */
  cleanup: () => Promise<void>;
}

/** Base connection URL for tests, without any schema override. */
function baseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "createTestDb requires TEST_DATABASE_URL or DATABASE_URL to point at a PostgreSQL instance " +
        "(e.g. postgresql://authpilot:authpilot@localhost:5433/authpilot).",
    );
  }
  return url;
}

/** Build a connection URL that targets `schema`, replacing any existing override. */
function urlWithSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

/**
 * Create an isolated temporary PostgreSQL schema with the AuthPilot schema
 * applied, and return a PrismaClient connected to it.
 */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = urlWithSchema(baseUrl(), schema);

  // Apply the schema to the fresh namespace. `db push` is schema-first and needs
  // no migration history — ideal for ephemeral test schemas. Prisma creates the
  // named schema if it does not exist.
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      stdio: "ignore",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  const cleanup = async (): Promise<void> => {
    try {
      // `$executeRawUnsafe` is required here because a schema name cannot be a
      // bound parameter; the name is server-generated (randomBytes) and never
      // user-derived, so there is no injection surface.
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await prisma.$disconnect();
    }
  };

  return { prisma, databaseUrl, schema, cleanup };
}
