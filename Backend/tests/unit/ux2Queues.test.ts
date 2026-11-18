/**
 * UX-2 queues, database-free: the `replyTasks` task filter (Replies queue / call queue) and logCall
 * accepting an open follow-up task (call queue). The staging integration test workListsApi covers
 * the same through HTTP + SQL.
 */
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/authMiddleware.js";
import type { Queryable } from "../../src/dto.js";
import { REPLY_TASK_TITLES } from "../../src/agent/replyClassification.js";
import {
  countWorkTasks,
  taskFilterSchema,
} from "../../src/services/workLists.service.js";
import { logCall } from "../../src/services/calls.service.js";

const actor = {
  id: "user-1",
  fullName: "Rep One",
  role: "salesperson",
} as unknown as Actor;

function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ count: "0" }], rowCount: 1 };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe("UX-2 replyTasks filter", () => {
  it("accepts only|exclude and nothing else", () => {
    expect(taskFilterSchema.parse({ replyTasks: "only" }).replyTasks).toBe(
      "only",
    );
    expect(taskFilterSchema.parse({ replyTasks: "exclude" }).replyTasks).toBe(
      "exclude",
    );
    expect(taskFilterSchema.safeParse({ replyTasks: "all" }).success).toBe(
      false,
    );
  });

  it("only = the AI's reply tasks (origin agent + a reply title); exclude = everything else", async () => {
    for (const mode of ["only", "exclude"] as const) {
      const { db, calls } = capture();
      await countWorkTasks(db, actor, "ws-1", { replyTasks: mode });
      const { sql, params } = calls[0]!;
      const clause =
        /(not )?\(t\.origin = 'agent' and t\.title = any\(\$(\d+)::text\[\]\)\)/.exec(
          sql,
        );
      expect(clause, sql).not.toBeNull();
      expect(Boolean(clause![1])).toBe(mode === "exclude");
      expect(params[Number(clause![2]) - 1]).toEqual(REPLY_TASK_TITLES);
    }
  });
});

/** A fake transaction that answers logCall's first queries; the task row decides the rest. */
function callDb(taskType: string) {
  return {
    query: async (sql: string) => {
      if (/from public\.tasks where id = \$1/.test(sql))
        return {
          rows: [
            {
              id: "task-1",
              lead_id: "lead-1",
              task_type: taskType,
              status: "open",
            },
          ],
          rowCount: 1,
        };
      if (sql.includes("insert into public.calls"))
        return {
          rows: [
            {
              id: "call-1",
              lead_id: "lead-1",
              created_at: new Date(),
              connected: false,
            },
          ],
          rowCount: 1,
        };
      // The lead (and anything else): an active contact.
      return {
        rows: [
          {
            id: "lead-1",
            workspace_id: "ws-1",
            lifecycle_state: "active",
            owner_id: "user-1",
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as Queryable;
}

describe("UX-2 logCall with a task", () => {
  const input = {
    connected: false,
    notConnectedReason: "no_answer" as const,
    taskId: "task-1",
  };

  it("refuses task types other than call / follow-up", async () => {
    await expect(
      logCall(callDb("send_email"), actor, "ws-1", "lead-1", input),
    ).rejects.toThrow(
      "Only a call or follow-up task can be completed by logging a call.",
    );
  });

  it("lets an open follow-up task through the type check (the call queue works follow-ups)", async () => {
    // Later steps hit the fake DB's limits; only the type rule matters here.
    const error = await logCall(
      callDb("follow_up"),
      actor,
      "ws-1",
      "lead-1",
      input,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(error)).not.toMatch(/Only a call/);
  });
});
