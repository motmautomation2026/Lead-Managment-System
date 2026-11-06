import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (e: unknown) => String(e),
  useUpdateAgentSettings: () => ({ mutate: mocks.mutate, isPending: false }),
}));

import { TargetIndustriesCard } from "./target-industries-card";
import { parseIndustries } from "./target-industries";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("E3b-2b Target industries", () => {
  it("comma-separated, trimmed, lower case, de-duplicated", () => {
    expect(parseIndustries(" Steel, EPC ,, steel,water treatment ")).toEqual([
      "steel",
      "epc",
      "water treatment",
    ]);
    expect(parseIndustries("")).toEqual([]);
  });

  it("shows the saved list and saves the edited one", async () => {
    render(<TargetIndustriesCard keywords={["steel", "pumps"]} />);
    const input = screen.getByLabelText("Industries, separated by commas");
    expect(input).toHaveValue("steel, pumps");
    fireEvent.change(input, { target: { value: "steel, Valves" } });
    fireEvent.click(screen.getByRole("button", { name: "Save target industries" }));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        { targetIndustryKeywords: ["steel", "valves"] },
        expect.anything(),
      ),
    );
  });
});
