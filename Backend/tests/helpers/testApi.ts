/**
 * The real HTTP stack (createApp) for integration tests, with auth bypassed by
 * setting req.actor (requireAuth then skips the token check), as in roles.test.ts.
 * Test users are `@example.com` auth users, deleted by close().
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { expect } from "vitest";
import type { Actor } from "../../src/authMiddleware.js";

// Response bodies are JSON checked by expect(); typing every shape adds nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = any;

export interface TestApi {
  newUser(role: "admin" | "salesperson", options?: { isActive?: boolean; name?: string }): Promise<Actor>;
  call(as: Actor, workspaceId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: JsonBody }>;
  close(): Promise<void>;
}

export async function startTestApi(pool: Pool, label: string): Promise<TestApi> {
  const authUserIds: string[] = [];
  let actor: Actor | undefined;
  const { createApp } = await import("../../src/app.js");
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(createApp());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  return {
    async newUser(role, options = {}) {
      const isActive = options.isActive ?? true;
      const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${label}-${role}-${randomUUID()}@example.com`]);
      authUserIds.push(auth.rows[0].id);
      const profile = await pool.query(
        `update public.profiles set role = $2, is_active = $3, full_name = coalesce($4, full_name) where id = $1 returning id, full_name, email`,
        [auth.rows[0].id, role, isActive, options.name ?? null],
      );
      return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive, role };
    },
    async call(as, workspaceId, method, path, body) {
      actor = as;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const id of authUserIds) {
        await pool.query(`delete from auth.users where id = $1`, [id]).catch((error: Error) => console.warn(`[${label}] test user not deleted: ${error.message}`));
      }
    },
  };
}

/** `a=1&b=x&b=y` from an object (arrays repeat). */
export function qs(params: Record<string, string | number | boolean | (string | number)[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * Pages through `path` with limit `pageSize` and checks the list-standard contract:
 * every page ≤ pageSize, no duplicates, the same rows in the same order as one
 * unpaginated (limit 100) call. Returns the ids in order.
 */
export async function expectConsistentPaging(
  get: (query: string) => Promise<{ status: number; body: JsonBody }>,
  params: Record<string, string | number | boolean | (string | number)[] | undefined>,
  pageSize = 7,
): Promise<string[]> {
  const all = await get(qs({ ...params, limit: 100 }));
  expect(all.status, JSON.stringify(all.body)).toBe(200);
  expect(all.body.nextCursor).toBeNull();
  const expected: string[] = all.body.data.map((r: { id: string }) => r.id);

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await get(qs({ ...params, limit: pageSize, cursor }));
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.data.length).toBeLessThanOrEqual(pageSize);
    seen.push(...page.body.data.map((r: { id: string }) => r.id));
    cursor = page.body.nextCursor ?? undefined;
    if (!cursor) break;
    expect(page.body.data.length).toBe(pageSize);
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toEqual(expected);
  return seen;
}
