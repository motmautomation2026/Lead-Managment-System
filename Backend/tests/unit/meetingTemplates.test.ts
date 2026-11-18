import { describe, expect, it, vi } from "vitest";
import { getDefaultTemplate } from "../../src/services/meetingScheduledNotification.service.js";
import { updateTemplate, type TemplateRow } from "../../src/services/workflows.service.js";

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

function templateRow(channel: "email" | "whatsapp"): TemplateRow {
  return {
    id: "tpl-a",
    workspace_id: "ws-a",
    name: "Meeting booked",
    channel,
    subject: null,
    body: "Hi",
    is_active: true,
    is_default_meeting_scheduled_email: false,
    is_default_meeting_scheduled_whatsapp: false,
    created_at: new Date("2030-01-01T00:00:00Z"),
    updated_at: new Date("2030-01-01T00:00:00Z"),
  };
}

describe("updateTemplate default meeting template (B3)", () => {
  it.each([
    ["email", "is_default_meeting_scheduled_email"],
    ["whatsapp", "is_default_meeting_scheduled_whatsapp"],
  ] as const)("clears only this workspace's previous %s default", async (channel, column) => {
    const row = templateRow(channel);
    const query = vi.fn(async (sql: string, _params?: unknown[]) => (norm(sql).startsWith("select") ? { rows: [row] } : { rows: [] }));

    await updateTemplate({ query } as never, "ws-a", "tpl-a", { isDefaultMeetingScheduled: true });

    const clear = query.mock.calls.find(([sql]) => norm(sql).includes(`set ${column} = false`))!;
    expect(norm(clear[0])).toBe(`update public.message_templates set ${column} = false where workspace_id = $1 and ${column} = true and id != $2`);
    expect(clear[1]).toEqual(["ws-a", "tpl-a"]);
  });

  it("does not clear anything when unsetting the default", async () => {
    const query = vi.fn(async (sql: string) => (norm(sql).startsWith("select") ? { rows: [templateRow("email")] } : { rows: [] }));
    await updateTemplate({ query } as never, "ws-a", "tpl-a", { isDefaultMeetingScheduled: false });
    expect(query.mock.calls.some(([sql]) => norm(sql).includes("= false where"))).toBe(false);
  });
});

describe("getDefaultTemplate (B3)", () => {
  it.each([
    ["email", "is_default_meeting_scheduled_email"],
    ["whatsapp", "is_default_meeting_scheduled_whatsapp"],
  ] as const)("filters the %s default by workspace", async (channel, column) => {
    const query = vi.fn(async () => ({ rows: [{ id: "tpl-b" }] }));
    await expect(getDefaultTemplate("ws-b", channel, { query } as never)).resolves.toEqual({ id: "tpl-b" });
    expect(norm((query.mock.calls[0] as unknown[])[0] as string)).toBe(
      `select * from public.message_templates where workspace_id = $1 and ${column} = true and is_active = true limit 1`,
    );
    expect((query.mock.calls[0] as unknown[])[1]).toEqual(["ws-b"]);
  });

  it("returns null when the workspace has no default", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(getDefaultTemplate("ws-c", "email", { query } as never)).resolves.toBeNull();
  });
});
