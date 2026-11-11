import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  SETTING_ENTRIES,
  adminRedirect,
  legacySettingsRedirect,
  searchSettings,
  sectionForPath,
  validateEmailSearch,
  validateWhatsAppSearch,
  visibleSections,
} from "./settings-search";

const salesperson = { isAdmin: false, canManageUsers: false, isSuperAdmin: false };
const admin = { isAdmin: true, canManageUsers: true, isSuperAdmin: false };
const superAdmin = { isAdmin: true, canManageUsers: true, isSuperAdmin: true };

describe("/admin and old /settings?tab= URLs (C6b, A5, UX-1)", () => {
  it("plain /admin opens User accounts", () => {
    expect(adminRedirect({})).toEqual({ section: "users", search: {} });
  });
  it("the Calendar OAuth landing keeps its query on the Calendar section", () => {
    expect(adminRedirect({ calendar: "connected" })).toEqual({
      section: "calendar",
      search: { calendar: "connected" },
    });
    expect(adminRedirect({ calendar: "error", message: "Denied" })).toEqual({
      section: "calendar",
      search: { calendar: "error", message: "Denied" },
    });
  });
  it("every old tab maps to its new section; unknown tabs show the list / default", () => {
    const map = Object.fromEntries(
      [
        "workspace",
        "assignment",
        "agent",
        "team",
        "users",
        "workspaces",
        "health",
        "profile",
        "appearance",
      ].map((tab) => [tab, legacySettingsRedirect({ tab })?.section]),
    );
    expect(map).toEqual({
      workspace: "email",
      assignment: "assignment",
      agent: "ai-agent",
      team: "team",
      users: "users",
      workspaces: "workspaces",
      health: "health",
      profile: "profile",
      appearance: "appearance",
    });
    expect(legacySettingsRedirect({ tab: "nope" })).toBeNull();
    expect(legacySettingsRedirect({})).toBeNull();
  });
});

describe("sections and permissions", () => {
  it("salespeople see channels, message rules and personal; admins add workspace + AI; super-admins add admin", () => {
    expect(visibleSections(salesperson).map((s) => s.id)).toEqual([
      "email",
      "whatsapp",
      "calendar",
      "message-rules",
      "profile",
      "appearance",
    ]);
    const forAdmin = visibleSections(admin).map((s) => s.id);
    expect(forAdmin).toContain("team");
    expect(forAdmin).toContain("users");
    expect(forAdmin).not.toContain("workspaces");
    expect(visibleSections(superAdmin)).toHaveLength(SETTINGS_SECTIONS.length);
  });
  it("finds the section from the path", () => {
    expect(sectionForPath("/settings/email")?.id).toBe("email");
    expect(sectionForPath("/settings/")).toBeNull();
    expect(sectionForPath("/settings/nope")).toBeNull();
  });
  it("tab params fall back when unknown", () => {
    expect(validateEmailSearch({ tab: "safety" })).toEqual({ tab: "safety" });
    expect(validateEmailSearch({ tab: "nope" })).toEqual({});
    expect(validateWhatsAppSearch({ number: "x" })).toEqual({});
  });
});

describe("settings search", () => {
  it("finds a setting by name with its section, tab and field", () => {
    expect(searchSettings("daily cap", admin)[0]).toMatchObject({
      label: "Email daily cap",
      section: "email",
      tab: "safety",
      anchor: "email-dailyCap",
    });
    expect(searchSettings("whatsapp", admin)[0]?.label).toBe("WhatsApp");
    expect(searchSettings("dkim", admin)[0]?.label).toBe("Deliverability check");
  });
  it("never offers a section the viewer can't open", () => {
    expect(searchSettings("banned", salesperson).map((e) => e.section)).toEqual(["message-rules"]);
    expect(searchSettings("playbook", salesperson)).toEqual([]);
    expect(searchSettings("memberships", admin)).toEqual([]);
    expect(searchSettings("memberships", superAdmin)).toHaveLength(1);
  });
  it("every entry points at a real section", () => {
    const ids = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));
    expect(SETTING_ENTRIES.every((e) => ids.has(e.section))).toBe(true);
  });
});
