import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  get: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/store", () => {
  const users = [
    { id: "a", name: "Person A", active: true },
    { id: "b", name: "Person B", active: true },
  ];
  return {
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({
      users,
      userName: (id?: string) => users.find((user) => user.id === id)?.name ?? "Unassigned",
    }),
  };
});
vi.mock("@/lib/backend-client", () => ({
  backend: { assignmentRules: { get: mocks.get, replace: mocks.replace } },
}));

import { renderInRouter } from "@/test/render-in-router";
import { LeadAssignmentPanel } from "./lead-assignment-panel";
import { previewOwner, ruleRowsProblem, rowsToRules } from "./lead-assignment-rules";

afterEach(cleanup);

function renderPanel() {
  mocks.get.mockResolvedValue({
    rules: [
      {
        id: "r1",
        position: 0,
        minCr: null,
        maxCr: 5,
        ownerId: "a",
        ownerName: "Person A",
        ownerActive: true,
      },
      {
        id: "r2",
        position: 1,
        minCr: 5,
        maxCr: null,
        ownerId: "b",
        ownerName: "Person B",
        ownerActive: true,
      },
    ],
    fallbackOwnerId: null,
    fallbackOwnerName: null,
    fallbackOwnerAvailable: true,
  });
  return renderInRouter(() => <LeadAssignmentPanel workspaceId="ws-1" />);
}

describe("LeadAssignmentPanel", () => {
  it("is hidden from salespeople and never loads the rules", async () => {
    mocks.isAdmin = false;
    const view = await renderPanel();
    expect(view.container).toBeEmptyDOMElement();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("shows admins the rules, a live preview and the new-leads hint", async () => {
    mocks.isAdmin = true;
    await renderPanel();
    expect(await screen.findAllByTestId("rule-row")).toHaveLength(2);
    expect(screen.getByText("Applies to new leads only.")).toBeInTheDocument();
    expect(screen.getByText("Person A", { selector: "strong" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preview revenue in crore"), {
      target: { value: "5.01" },
    });
    expect(screen.getByText("Person B", { selector: "strong" })).toBeInTheDocument();
  });

  it("blocks saving an invalid rule and saves a valid list from the save bar", async () => {
    mocks.isAdmin = true;
    mocks.replace.mockResolvedValue({
      rules: [],
      fallbackOwnerId: null,
      fallbackOwnerName: null,
      fallbackOwnerAvailable: true,
    });
    await renderPanel();
    await screen.findAllByTestId("rule-row");
    expect(screen.queryByRole("button", { name: "Save rules" })).toBeNull();

    fireEvent.change(
      screen.getByLabelText("From (₹ Cr, exclusive, optional)", { selector: "#rule-0-from" }),
      { target: { value: "10" } },
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      'Rule 1: "From" must be less than "Up to".',
    );
    expect(screen.getByRole("button", { name: "Save rules" })).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText("From (₹ Cr, exclusive, optional)", { selector: "#rule-0-from" }),
      { target: { value: "" } },
    );
    // Back to the saved rules: nothing to save.
    expect(screen.queryByRole("button", { name: "Save rules" })).toBeNull();
    fireEvent.change(screen.getByLabelText("When revenue is unknown or no rule matches"), {
      target: { value: "a" },
    });
    const save = screen.getByRole("button", { name: "Save rules" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith({
        rules: [
          { position: 0, minCr: null, maxCr: 5, ownerId: "a" },
          { position: 1, minCr: 5, maxCr: null, ownerId: "b" },
        ],
        fallbackOwnerId: "a",
      }),
    );
  });
});

describe("rule editor validation", () => {
  it.each([
    [[{ from: "", to: "5", ownerId: "" }], "Rule 1: choose an owner."],
    [
      [{ from: "abc", to: "", ownerId: "a" }],
      "Rule 1: enter revenue as a positive number of crore.",
    ],
    [
      [{ from: "-1", to: "", ownerId: "a" }],
      "Rule 1: enter revenue as a positive number of crore.",
    ],
    [
      [
        { from: "", to: "5", ownerId: "a" },
        { from: "5", to: "5", ownerId: "b" },
      ],
      'Rule 2: "From" must be less than "Up to".',
    ],
  ])("rejects %j", (rows, message) => {
    expect(ruleRowsProblem(rows)).toBe(message);
  });

  it("accepts open-ended rows and numbers them in order", () => {
    const rows = [
      { from: "", to: "5", ownerId: "a" },
      { from: " 5 ", to: "", ownerId: "b" },
    ];
    expect(ruleRowsProblem(rows)).toBeNull();
    expect(rowsToRules(rows)).toEqual([
      { position: 0, minCr: null, maxCr: 5, ownerId: "a" },
      { position: 1, minCr: 5, maxCr: null, ownerId: "b" },
    ]);
    expect(previewOwner(rows, 5)).toBe("a");
    expect(previewOwner(rows, 5.01)).toBe("b");
    expect(previewOwner([], 1)).toBeUndefined();
  });
});
