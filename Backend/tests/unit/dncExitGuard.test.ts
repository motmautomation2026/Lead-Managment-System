import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/authMiddleware.js";
import { DoNotContactError } from "../../src/errors.js";
import { markDiscarded, markLost, markWon, mergeLead, moveToLongTermNurture } from "../../src/services/leads.service.js";

const WS = "ws-1";
const actor: Actor = { id: "user-1", fullName: "Rep", email: "rep@example.com", isActive: true, role: "salesperson" };
const MESSAGE = "This lead is Do Not Contact. Reactivate it with a reason first.";

/** Leads keyed by id; records every statement so a refused call can be shown to write nothing. */
function fakeDb(lifecycles: Record<string, string>) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^select .* from public\.leads/i.test(s)) {
      const id = params.find((p) => typeof p === "string" && p in lifecycles) as string | undefined;
      return { rows: id ? [{ id, workspace_id: WS, first_name: "A", last_name: "B", company: "C", lifecycle_state: lifecycles[id] }] : [], rowCount: id ? 1 : 0 };
    }
    if (!/^select/i.test(s)) writes.push(s);
    return { rows: [], rowCount: 0 };
  });
  return { db: { query } as never, writes };
}

const guarded = [
  ["markWon", (db: never, id: string) => markWon(db, actor, WS, id)],
  ["markLost", (db: never, id: string) => markLost(db, actor, WS, id, "price_budget")],
  ["markDiscarded", (db: never, id: string) => markDiscarded(db, actor, WS, id, "spam")],
  ["moveToLongTermNurture", (db: never, id: string) => moveToLongTermNurture(db, actor, WS, id)],
  ["mergeLead (source)", (db: never, id: string) => mergeLead(db, actor, WS, id, "target")],
] as const;

describe("Do Not Contact exit guard (B5)", () => {
  it.each(guarded)("%s refuses a DNC lead with a 409 and writes nothing", async (_name, call) => {
    const { db, writes } = fakeDb({ lead: "do_not_contact", target: "active" });
    const error = await call(db, "lead").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoNotContactError);
    expect(error).toMatchObject({ status: 409, code: "do_not_contact", message: MESSAGE });
    expect(writes).toEqual([]);
  });

  it.each(guarded)("%s still works for an active lead", async (_name, call) => {
    const { db, writes } = fakeDb({ lead: "active", target: "active" });
    await expect(call(db, "lead")).resolves.toBeDefined();
    expect(writes.some((s) => s.startsWith("update public.leads"))).toBe(true);
  });

  it("mergeLead still allows a DNC lead as the merge target", async () => {
    const { db } = fakeDb({ lead: "active", target: "do_not_contact" });
    await expect(mergeLead(db, actor, WS, "lead", "target")).resolves.toBeDefined();
  });
});
