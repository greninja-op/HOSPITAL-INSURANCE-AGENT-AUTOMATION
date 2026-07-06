// =============================================================================
// lib/db.ts
//
// Shared Prisma client module for AuthPilot. Every API route, the nine-stage
// Agent_Runner, and the hardening modules import the SAME `prisma` instance
// from here so the app opens exactly one connection pool.
//
// In development, Next.js hot-reloading re-evaluates modules on every change,
// which would otherwise spawn a new PrismaClient (and connection pool) each
// time. We stash the instance on `globalThis` to survive reloads.
// =============================================================================

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
