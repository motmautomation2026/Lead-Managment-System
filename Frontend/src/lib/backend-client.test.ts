import { afterEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase-client", () => ({
  backendBaseUrl: "https://api.example.test",
  configurationError: null,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "session-token" } },
        error: null,
      })),
      signOut,
    },
  },
}));

import {
  BackendError,
  backend,
  getCurrentWorkspaceId,
  listQuery,
  setCurrentWorkspaceId,
} from "./backend-client";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  signOut.mockClear();
  setCurrentWorkspaceId(null);
});

describe("backend client", () => {
  it.each([
    [
      "lead",
      () => backend.leads.create({ firstName: "Ada", company: "Northbeam", source: "referral" }),
      "POST",
      "/api/v1/leads",
    ],
    [
      "call",
      () => backend.leads.logCall("lead-1", { connected: false, notConnectedReason: "no_answer" }),
      "POST",
      "/api/v1/leads/lead-1/calls",
    ],
    [
      "task edit",
      () => backend.tasks.update("task-1", { dueAt: "2026-08-28T04:30:00.000Z" }),
      "PATCH",
      "/api/v1/tasks/task-1",
    ],
    [
      "meeting",
      () =>
        backend.meetings.create({
          leadId: "lead-1",
          title: "Discovery",
          at: "2026-08-28T04:30:00.000Z",
        }),
      "POST",
      "/api/v1/meetings",
    ],
    [
      "workflow publish",
      () => backend.workflows.publish("workflow-1", 3),
      "POST",
      "/api/v1/workflows/workflow-1/versions/3/publish",
    ],
    [
      "admin user",
      () =>
        backend.admin.users.create({
          name: "Ada Administered",
          email: "ada@example.com",
          password: "permanent-password",
        }),
      "POST",
      "/api/v1/admin/users",
    ],
    [
      "WhatsApp connect",
      () => backend.connections.whatsapp.command("connect"),
      "POST",
      "/api/v1/connections/whatsapp/connect",
    ],
    [
      "assignment rules replace",
      () => backend.assignmentRules.replace({ rules: [], fallbackOwnerId: null }),
      "PUT",
      "/api/v1/assignment-rules",
    ],
    [
      "agent settings update",
      () => backend.agent.settings.update({ mode: "shadow", sendDays: [1, 2] }),
      "PUT",
      "/api/v1/agent/settings",
    ],
    [
      "playbook save",
      () => backend.agent.playbooks.create("Who we are"),
      "POST",
      "/api/v1/agent/playbooks",
    ],
    [
      "playbook restore",
      () => backend.agent.playbooks.restore(2),
      "POST",
      "/api/v1/agent/playbooks/2/restore",
    ],
    [
      "workspace create",
      () => backend.workspaces.create("Second Brand"),
      "POST",
      "/api/v1/workspaces",
    ],
  ])("sends an authenticated %s request", async (_name, invoke, method, pathname) => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ id: "result-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await invoke();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.example.test${pathname}`);
    expect(init).toMatchObject({
      method,
      headers: { Authorization: "Bearer session-token", "Content-Type": "application/json" },
    });
  });

  it("reads agent settings and playbooks with GET, and sends the playbook body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await backend.agent.settings.get();
    await backend.agent.playbooks.list();
    await backend.agent.playbooks.create("Tone: warm");

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]);
    expect(calls).toEqual([
      ["https://api.example.test/api/v1/agent/settings", "GET"],
      ["https://api.example.test/api/v1/agent/playbooks", "GET"],
      ["https://api.example.test/api/v1/agent/playbooks", "POST"],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({ body: "Tone: warm" });
  });

  it("uploads a proposal document with its multipart fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ id: "proposal-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const document = new File(["proposal contents"], "proposal.pdf", { type: "application/pdf" });
    await backend.proposals.create({
      leadId: "lead-1",
      title: "Proposal",
      emailTemplateId: "template-email-1",
      whatsappTemplateId: "template-whatsapp-1",
      document,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/proposals");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer session-token" });
    expect(init?.headers).not.toHaveProperty("Content-Type");
    const body = init?.body as FormData;
    expect(body.get("leadId")).toBe("lead-1");
    expect(body.get("title")).toBe("Proposal");
    expect(body.get("emailTemplateId")).toBe("template-email-1");
    expect(body.get("whatsappTemplateId")).toBe("template-whatsapp-1");
    expect(body.get("document")).toBe(document);
  });

  it("saves email settings with PUT /connections/email/settings, retained secrets omitted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ configured: true }));
    vi.stubGlobal("fetch", fetchMock);

    await backend.connections.email.update({
      enabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecurity: "ssl",
      fromAddress: "sales@example.com",
      fromName: "Northbeam",
      replyTo: "",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "ssl",
      imapSameLogin: true,
      imapFolder: "INBOX",
      dailyCap: 100,
      hourlyCap: 20,
      minDelaySeconds: 30,
      maxDelaySeconds: 90,
      sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
      alreadyWarmed: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/v1/connections/email/settings");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("smtpPassword");
    expect(body).not.toHaveProperty("provider");
  });

  it("attaches X-Workspace-Id once a workspace is selected, and omits it before then", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await backend.workflows.list();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty(["headers", "X-Workspace-Id"]);

    setCurrentWorkspaceId("workspace-1");
    expect(getCurrentWorkspaceId()).toBe("workspace-1");
    await backend.workflows.list();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { "X-Workspace-Id": "workspace-1" },
    });
  });

  it("normalizes API errors and clears an unauthorized local session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            error: {
              code: "invalid_session",
              message: "Session expired",
              details: { retry: false },
            },
          },
          401,
        ),
      ),
    );

    await expect(backend.me()).rejects.toEqual(
      expect.objectContaining<Partial<BackendError>>({
        status: 401,
        code: "invalid_session",
        message: "Session expired",
      }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("listQuery", () => {
  it("repeats array params and drops empty values (B4 multi-value filters)", () => {
    expect(
      listQuery("/contacts", {
        ownerId: ["me", "none"],
        q: "",
        lifecycle: [],
        limit: 50,
        cursor: undefined,
      }),
    ).toBe("/contacts?ownerId=me&ownerId=none&limit=50");
    expect(listQuery("/contacts", {})).toBe("/contacts");
  });
});
