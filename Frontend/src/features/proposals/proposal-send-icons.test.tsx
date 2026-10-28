import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProposalListItem } from "@/types";
import { sendingPollInterval } from "@/lib/proposal-sending";
import { ProposalSendIcons } from "./proposal-send-icons";

const row = (extra: Partial<ProposalListItem>) =>
  ({
    id: "p-1",
    emailSendStatus: "pending",
    whatsappSendStatus: "not_applicable",
    updatedAt: new Date().toISOString(),
    ...extra,
  }) as ProposalListItem;

afterEach(cleanup);

describe("ProposalSendIcons email pill (E1b)", () => {
  it("a queued email says Queued, with why it waits when asked", () => {
    render(
      <ProposalSendIcons
        proposal={row({ emailSendError: "Hourly cap (20) reached." })}
        showReason
      />,
    );
    expect(screen.getByText("Email: Queued")).toBeInTheDocument();
    expect(screen.getByText("Hourly cap (20) reached.")).toBeInTheDocument();
  });

  it("sent and failed (with the reason as tooltip)", () => {
    render(<ProposalSendIcons proposal={row({ emailSendStatus: "sent" })} />);
    expect(screen.getByText("Email: Sent")).toBeInTheDocument();
    cleanup();
    render(
      <ProposalSendIcons
        proposal={row({
          emailSendStatus: "failed",
          emailSendError: "The contact is Do Not Contact.",
        })}
      />,
    );
    expect(screen.getByText("Email: Failed").closest("[title]")).toHaveAttribute(
      "title",
      "Email failed — The contact is Do Not Contact.",
    );
  });

  it("the list polls while an email is queued", () => {
    const now = Date.now();
    expect(sendingPollInterval([row({})], now)).not.toBe(false);
    expect(sendingPollInterval([row({ emailSendStatus: "sent" })], now)).toBe(false);
  });
});
