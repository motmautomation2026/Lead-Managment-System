/** Document types an admin can pick ('asset' documents come from the asset library). */
export const DOC_TYPE_OPTIONS = [
  ["service", "Service"],
  ["case_study", "Case study"],
  ["faq", "FAQ"],
  ["objection", "Objection"],
  ["pricing", "Pricing"],
  ["process", "Process"],
  ["company", "Company"],
  ["other", "Other"],
] as const;

export function docTypeLabel(value: string): string {
  if (value === "asset") return "Asset";
  return DOC_TYPE_OPTIONS.find(([key]) => key === value)?.[1] ?? value;
}

/** "Pricing, commercial ,pricing" → ["pricing", "commercial"] (the backend normalises the same way). */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MB = 1024 * 1024;
const extensionOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

export const DOCUMENT_ACCEPT = ".pdf,.docx,.pptx,.md,.markdown,.txt";
export const ASSET_ACCEPT = ".pdf,.pptx,.docx,.png,.jpg,.jpeg";

export interface KnowledgeFormInput {
  mode: "file" | "text";
  file: File | null;
  title: string;
  text: string;
}

/** The first thing to fix before the add-knowledge form can be sent, or null. The backend re-checks. */
export function knowledgeFormProblem(input: KnowledgeFormInput): string | null {
  if (input.mode === "file") {
    if (!input.file) return "Choose a file to upload.";
    if (!["pdf", "docx", "pptx", "md", "markdown", "txt"].includes(extensionOf(input.file.name)))
      return "Upload a PDF, DOCX, PPTX, Markdown or text file.";
    if (input.file.size > 20 * MB) return "Files can be up to 20 MB.";
    return null;
  }
  if (!input.title.trim()) return "Give the text a title.";
  if (!input.text.trim()) return "Paste some text.";
  return null;
}

export interface AssetFormInput {
  file: File | null;
  title: string;
  useWhen: string;
  channels: string[];
}

export function assetFormProblem(input: AssetFormInput): string | null {
  if (!input.file) return "Choose the file the agent may attach.";
  if (!["pdf", "pptx", "docx", "png", "jpg", "jpeg"].includes(extensionOf(input.file.name)))
    return "Upload a PDF, PPTX, DOCX, PNG or JPEG file.";
  if (input.file.size > 10 * MB) return "Assets can be up to 10 MB.";
  if (!input.title.trim()) return "Give the asset a title.";
  if (!input.useWhen.trim()) return "Describe when the agent should use it.";
  if (input.channels.length === 0) return "Choose at least one channel.";
  return null;
}
