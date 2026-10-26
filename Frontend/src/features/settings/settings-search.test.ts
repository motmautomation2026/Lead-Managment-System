import { describe, expect, it } from "vitest";
import { adminRedirectSearch, validateSettingsSearch } from "./settings-search";

describe("/admin → /settings (C6b, A5)", () => {
  it("plain /admin opens Users", () => {
    expect(adminRedirectSearch({})).toEqual({ tab: "users" });
  });
  it("the Calendar OAuth landing keeps its query on the Workspace tab", () => {
    expect(adminRedirectSearch({ calendar: "connected" })).toEqual({
      tab: "workspace",
      calendar: "connected",
      message: undefined,
    });
    expect(adminRedirectSearch({ calendar: "error", message: "Denied" })).toEqual({
      tab: "workspace",
      calendar: "error",
      message: "Denied",
    });
  });
  it("unknown tabs fall back to the default", () => {
    expect(validateSettingsSearch({ tab: "nope" })).toEqual({});
  });
});
