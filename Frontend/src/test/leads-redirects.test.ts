import { describe, expect, it } from "vitest";
import { Route as LeadsIndex } from "@/routes/leads.index";
import { Route as LeadDetail } from "@/routes/leads.$leadId";

type Redirect = { options: { to: string; params?: unknown; search?: unknown } };
function thrownRedirect(run: () => unknown): Redirect["options"] {
  try {
    run();
  } catch (error) {
    return (error as Redirect).options;
  }
  throw new Error("expected a redirect");
}
const beforeLoad = (route: { options: unknown }) =>
  (route.options as { beforeLoad: (ctx: unknown) => unknown }).beforeLoad;

describe("old /leads routes", () => {
  it("/leads → /contacts, mapping the params it can", () => {
    const to = thrownRedirect(() =>
      beforeLoad(LeadsIndex)({ search: { search: "asha", stage: "new", ownerId: "me" } }),
    );
    expect(to.to).toBe("/contacts");
    expect(to.search).toEqual({ q: "asha", leadStatus: ["new"], ownerId: ["me"] });
    expect(thrownRedirect(() => beforeLoad(LeadsIndex)({ search: {} })).search).toEqual({});
  });

  it("/leads/$leadId → /contacts/$contactId", () => {
    const to = thrownRedirect(() => beforeLoad(LeadDetail)({ params: { leadId: "abc" } }));
    expect(to).toMatchObject({ to: "/contacts/$contactId", params: { contactId: "abc" } });
  });
});
