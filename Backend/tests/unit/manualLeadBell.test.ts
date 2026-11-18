import { describe, expect, it } from "vitest";
import { manualLeadBellTitle } from "../../src/services/leads.service.js";

describe("manualLeadBellTitle (UX-3, LL-2: a manual first call is due now)", () => {
  it("an inbound enquiry entered by hand says call now, never 'within 1 hour'", () => {
    expect(manualLeadBellTitle("website")).toBe("New lead — call now");
    expect(manualLeadBellTitle("inbound_form")).toBe("New lead — call now");
  });
  it("other sources keep the plain assignment bell", () => {
    expect(manualLeadBellTitle("referral")).toBe("New lead assigned to you");
    expect(manualLeadBellTitle("linkedin")).toBe("New lead assigned to you");
  });
});
