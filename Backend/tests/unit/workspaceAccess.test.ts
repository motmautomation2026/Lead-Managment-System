import { describe, expect, it } from "vitest";
import { changeRoleProblem, effectiveWorkspaceRole, isLastAdmin, removeMemberProblem, type MemberRow } from "../../src/domain/workspaceAccess.js";

const none = { contacts: 0, deals: 0, tasks: 0 };
const members: MemberRow[] = [
  { userId: "a", role: "admin" },
  { userId: "s", role: "salesperson" },
];

describe("effectiveWorkspaceRole", () => {
  it("member role, super-admin = admin everywhere, non-member = no access", () => {
    expect(effectiveWorkspaceRole("salesperson", false)).toBe("salesperson");
    expect(effectiveWorkspaceRole("admin", false)).toBe("admin");
    expect(effectiveWorkspaceRole(null, false)).toBeNull();
    expect(effectiveWorkspaceRole(null, true)).toBe("admin");
    expect(effectiveWorkspaceRole("salesperson", true)).toBe("admin");
  });
});

describe("last admin", () => {
  it("only the single admin is the last admin", () => {
    expect(isLastAdmin(members, "a")).toBe(true);
    expect(isLastAdmin(members, "s")).toBe(false);
    expect(isLastAdmin([...members, { userId: "b", role: "admin" }], "a")).toBe(false);
  });
  it("can't be demoted or removed; another member can", () => {
    expect(changeRoleProblem(members, "a", "salesperson")).toMatch(/last admin/);
    expect(changeRoleProblem(members, "a", "admin")).toBeNull();
    expect(changeRoleProblem(members, "s", "admin")).toBeNull();
    expect(removeMemberProblem(members, "a", none)).toMatch(/last admin/);
    expect(removeMemberProblem(members, "s", none)).toBeNull();
  });
});

describe("removeMemberProblem", () => {
  it("blocks while the user owns work, with the counts", () => {
    expect(removeMemberProblem(members, "s", { contacts: 3, deals: 1, tasks: 0 })).toBe(
      "This user still owns 3 active contact(s), 1 open deal(s) and 0 open task(s) in this workspace. Reassign them first.",
    );
  });
  it("a non-member can't be removed or changed", () => {
    expect(removeMemberProblem(members, "x", none)).toMatch(/isn't a member/);
    expect(changeRoleProblem(members, "x", "admin")).toMatch(/isn't a member/);
  });
});
