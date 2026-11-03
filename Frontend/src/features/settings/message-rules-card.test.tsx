import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => ({
  messageFromError: () => "Failed",
  useUpdateAgentSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageRulesCard } from "./message-rules-card";

afterEach(cleanup);

const rules = {
  bannedPhrases: ["touch base"],
  emailMaxWords: 120,
  whatsappMaxWords: 60,
  styleExamples: "",
};

describe("MessageRulesCard (E3b-1)", () => {
  it("describes today's rewrite behaviour, not the old 'rewritten once'", () => {
    for (const editable of [false, true]) {
      const { unmount } = render(<MessageRulesCard rules={rules} editable={editable} />);
      expect(
        screen.getByText(
          "Every AI message is checked against these. A message that breaks one is rewritten up to twice for simple problems, otherwise handed to the rep.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/rewritten once/)).toBeNull();
      unmount();
    }
  });

  it("E3b-1b: shows the WhatsApp target and what the word count includes", () => {
    for (const editable of [false, true]) {
      const { unmount } = render(<MessageRulesCard rules={rules} editable={editable} />);
      expect(screen.getByText(/aims for about 40/)).toBeTruthy();
      expect(screen.getByText(/not the signature, opt-out or booking line/)).toBeTruthy();
      unmount();
    }
  });
});
