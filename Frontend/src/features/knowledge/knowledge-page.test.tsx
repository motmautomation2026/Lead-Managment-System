import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeAsset, KnowledgeDocument, KnowledgeHit } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  search: {
    data: undefined as { data: KnowledgeHit[] } | undefined,
    mutate: vi.fn(),
    isPending: false,
  },
  upload: vi.fn(async () => ({})),
  createText: vi.fn(async () => ({})),
}));

const doc = (over: Partial<KnowledgeDocument>): KnowledgeDocument => ({
  id: "d1",
  title: "Pricing FAQ",
  docType: "faq",
  tags: ["pricing"],
  source: "text",
  fileName: null,
  mimeType: null,
  sizeBytes: null,
  status: "ready",
  error: null,
  chunkCount: 2,
  attemptCount: 0,
  isActive: true,
  assetId: null,
  processedAt: null,
  nextAttemptAt: null,
  createdBy: "Admin",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});
const asset: KnowledgeAsset = {
  id: "a1",
  title: "Case study deck",
  useWhen: "the lead asks for proof",
  tags: [],
  channels: ["email", "whatsapp"],
  fileName: "deck.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  isActive: true,
  kbDocumentId: "d3",
  status: "ready",
  error: null,
  chunkCount: 1,
  downloadUrl: "https://example.test/deck.pdf",
  createdBy: "Admin",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useKnowledge: () => ({
    documents: [
      doc({}),
      doc({
        id: "d2",
        title: "Scan",
        status: "failed",
        error: "No readable text found — the PDF may be scanned images.",
      }),
      doc({ id: "d3", title: "Case study deck", docType: "asset", assetId: "a1" }),
    ],
    assets: [asset],
    isLoading: false,
    error: null,
  }),
  useKnowledgeDocument: () => ({ data: undefined, error: null }),
  useKnowledgeSearch: () => mocks.search,
}));

import { AddKnowledgeDialog, KnowledgePage, RetrievalTab } from "./knowledge-page";
import { knowledgeFormProblem } from "./knowledge-form";

afterEach(cleanup);

describe("Knowledge page", () => {
  it("salespeople see the documents but no write controls", () => {
    mocks.isAdmin = false;
    render(<KnowledgePage />);
    const table = screen.getByRole("table", { name: "Knowledge documents" });
    expect(within(table).getByText("Pricing FAQ")).toBeInTheDocument();
    expect(within(table).getByText("Scan")).toBeInTheDocument();
    expect(within(table).getByText("Case study deck")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add knowledge/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reprocess/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "View Pricing FAQ" })).toBeInTheDocument();
    // The failure reason shows on hover.
    expect(screen.getByText("Failed").closest("[title]")).toHaveAttribute(
      "title",
      "No readable text found — the PDF may be scanned images.",
    );
  });

  it("admins get add, reprocess, delete and active toggles (asset documents are managed via the asset)", () => {
    mocks.isAdmin = true;
    render(<KnowledgePage />);
    expect(screen.getByRole("button", { name: /Add knowledge/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprocess Pricing FAQ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Pricing FAQ" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Case study deck" })).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });

  it("assets are a table: download for everyone, active toggle and delete for admins", () => {
    mocks.isAdmin = true;
    render(<KnowledgePage />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Assets" }), { button: 0, ctrlKey: false });
    const table = screen.getByRole("table", { name: "Assets" });
    expect(within(table).getByText("the lead asks for proof")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Download Case study deck" })).toHaveAttribute(
      "href",
      "https://example.test/deck.pdf",
    );
    expect(within(table).getByRole("switch", { name: "Active: Case study deck" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Delete Case study deck" })).toBeTruthy();
    cleanup();
    mocks.isAdmin = false;
    render(<KnowledgePage />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Assets" }), { button: 0, ctrlKey: false });
    const readOnly = screen.getByRole("table", { name: "Assets" });
    expect(within(readOnly).queryByRole("switch")).toBeNull();
    expect(within(readOnly).getAllByText("Active")).toHaveLength(2); // header + the read-only value
  });
});

describe("Add knowledge dialog", () => {
  const renderDialog = () =>
    render(
      <AddKnowledgeDialog
        open
        onOpenChange={() => undefined}
        knowledge={
          { upload: mocks.upload, createText: mocks.createText } as unknown as Parameters<
            typeof AddKnowledgeDialog
          >[0]["knowledge"]
        }
      />,
    );

  it("requires a file in file mode and sends it as multipart", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a file to upload.");
    expect(mocks.upload).not.toHaveBeenCalled();

    const input = screen.getByLabelText(/^File/);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Upload a PDF, DOCX, PPTX, Markdown or text file.",
    );

    fireEvent.change(input, {
      target: { files: [new File(["%PDF"], "deck.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), {
      target: { value: "Pricing, cost" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const form = (mocks.upload.mock.calls[0] as unknown as [FormData])[0];
    expect((form.get("file") as File).name).toBe("deck.pdf");
    expect(form.get("docType")).toBe("service");
    expect(form.get("tags")).toBe("pricing,cost");
    expect(form.get("title")).toBeNull();
  });

  it("requires a title and text in paste mode", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Plans start at ₹50,000." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the text a title.");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Pricing" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() =>
      expect(mocks.createText).toHaveBeenCalledWith({
        title: "Pricing",
        docType: "pricing",
        tags: [],
        text: "Plans start at ₹50,000.",
      }),
    );
  });

  it.each([
    [{ mode: "file", file: null, title: "", text: "" }, "Choose a file to upload."],
    [
      {
        mode: "file",
        file: new File([new Uint8Array(21 * 1024 * 1024)], "big.pdf"),
        title: "",
        text: "",
      },
      "Files can be up to 20 MB.",
    ],
    [{ mode: "file", file: new File(["x"], "notes.MD"), title: "", text: "" }, null],
    [{ mode: "text", file: null, title: "T", text: "   " }, "Paste some text."],
  ] as const)("validates %j", (input, problem) => {
    expect(knowledgeFormProblem(input)).toBe(problem);
  });
});

describe("Test retrieval", () => {
  it("renders results with title, type, score, page and text", () => {
    mocks.search.data = {
      data: [
        {
          chunkId: "c1",
          documentId: "d1",
          documentTitle: "Process PDF",
          docType: "process",
          content: "Then we run outreach campaigns.",
          metadata: { page: 2 },
          score: 0.9123,
        },
        {
          chunkId: "c2",
          documentId: "d3",
          documentTitle: "Case study deck",
          docType: "asset",
          content: "Asset: Case study deck.",
          metadata: { slide: 1, heading: "Results" },
          score: 0.5,
        },
      ],
    };
    render(<RetrievalTab />);
    const [first, second] = screen.getAllByTestId("search-result");
    expect(within(first!).getByText("Process PDF")).toBeInTheDocument();
    expect(within(first!).getByText("Process")).toBeInTheDocument();
    expect(within(first!).getByText("Page 2")).toBeInTheDocument();
    expect(within(first!).getByText("Score 0.912")).toBeInTheDocument();
    expect(within(first!).getByText("Then we run outreach campaigns.")).toBeInTheDocument();
    expect(within(second!).getByText("Slide 1 · Results")).toBeInTheDocument();
  });

  it("shows the empty state and sends the filters", () => {
    mocks.search.data = { data: [] };
    render(<RetrievalTab />);
    expect(screen.getByText("No results — add knowledge first.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Search/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Describe a lead or situation"), {
      target: { value: "Manufacturing, ₹3 Cr, worried about cost" },
    });
    fireEvent.change(screen.getByLabelText("Type (optional)"), { target: { value: "case_study" } });
    fireEvent.change(screen.getByLabelText("Tags (optional, comma-separated)"), {
      target: { value: "Manufacturing" },
    });
    fireEvent.click(button);
    expect(mocks.search.mutate).toHaveBeenCalledWith(
      {
        query: "Manufacturing, ₹3 Cr, worried about cost",
        docTypes: ["case_study"],
        tags: ["manufacturing"],
      },
      expect.any(Object),
    );
  });
});
