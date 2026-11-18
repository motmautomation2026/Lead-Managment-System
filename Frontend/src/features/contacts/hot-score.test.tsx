import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotScorePill } from "./hot-score";

afterEach(cleanup);

describe("E3b-2b HotScorePill", () => {
  it("band + score; a tap shows the reasons in plain words without opening the row", () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <HotScorePill score={65} band="hot" reasons={["replied_positive", "target_industry"]} />
      </div>,
    );
    const pill = screen.getByRole("button", { name: "Hot lead, score 65. Show why" });
    expect(pill).toHaveTextContent("Hot · 65");
    fireEvent.click(pill);
    expect(screen.getByText("Replied positively")).toBeInTheDocument();
    expect(screen.getByText("In a target industry")).toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("not scored yet → a dash", () => {
    render(<HotScorePill score={null} band={null} reasons={null} />);
    expect(screen.getByText("–")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("E3b-2b list sorts", () => {
  it('Tasks has a "Hottest first" view (my open tasks by the contact\'s score); Contacts shows the Hot column by default', async () => {
    const { BUILT_IN_VIEWS } = await import("@/features/tasks/tasks-search");
    expect(BUILT_IN_VIEWS.find((v) => v.id === "hottest")).toMatchObject({
      label: "Hottest first",
    });
    expect(BUILT_IN_VIEWS.find((v) => v.id === "hottest")!.state()).toEqual({
      ownerId: ["me"],
      sort: "hotScore:desc",
    });
    const { DEFAULT_COLUMNS } = await import("@/features/contacts/contacts-search");
    const { CONTACT_COLUMNS } = await import("@/features/contacts/contact-columns");
    expect(DEFAULT_COLUMNS).toContain("hotScore");
    expect(CONTACT_COLUMNS.find((c) => c.id === "hotScore")).toMatchObject({
      header: "Hot",
      sortable: true,
    });
  });
});
