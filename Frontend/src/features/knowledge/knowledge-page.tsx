import { useState, type ReactNode } from "react";
import { Download, Eye, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/app/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { StatusBadge } from "@/components/common/status-badge";
import type {
  KnowledgeAsset,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeStatus,
} from "@/lib/backend-client";
import { relDay } from "@/lib/format";
import {
  messageFromError,
  useIsAdmin,
  useKnowledge,
  useKnowledgeDocument,
  useKnowledgeSearch,
} from "@/store";
import {
  ASSET_ACCEPT,
  DOC_TYPE_OPTIONS,
  DOCUMENT_ACCEPT,
  assetFormProblem,
  docTypeLabel,
  formatBytes,
  knowledgeFormProblem,
  parseTags,
} from "./knowledge-form";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const STATUS_TONE = {
  pending: "warning",
  processing: "info",
  ready: "success",
  failed: "danger",
} as const;

function IngestStatus({ status, error }: { status: KnowledgeStatus | null; error: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">-</span>;
  // The error (or the reason it's waiting) shows on hover.
  return (
    <span title={error ?? undefined}>
      <StatusBadge value={status} tone={STATUS_TONE[status]} />
    </span>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Runs a write and reports the outcome; errors use the shared backend message. */
async function attempt(action: () => Promise<unknown>, success: string) {
  try {
    await action();
    toast.success(success);
    return true;
  } catch (error) {
    toast.error(messageFromError(error));
    return false;
  }
}

export function KnowledgePage() {
  const knowledge = useKnowledge();
  return (
    <div>
      <PageHeader
        title="Knowledge"
        description="What the AI agent may say (knowledge base) and attach (asset library) for this workspace."
      />
      <div className="p-6">
        {knowledge.error ? (
          <ErrorBlock error={knowledge.error} />
        ) : knowledge.isLoading ? (
          <LoadingBlock />
        ) : (
          <Tabs defaultValue="documents">
            <TabsList>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="assets">Assets</TabsTrigger>
              <TabsTrigger value="retrieval">Test retrieval</TabsTrigger>
            </TabsList>
            <TabsContent value="documents" className="mt-4">
              <DocumentsTab knowledge={knowledge} />
            </TabsContent>
            <TabsContent value="assets" className="mt-4">
              <AssetsTab knowledge={knowledge} />
            </TabsContent>
            <TabsContent value="retrieval" className="mt-4">
              <RetrievalTab />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

type Knowledge = ReturnType<typeof useKnowledge>;

// --- Documents ------------------------------------------------------------------

function DocumentsTab({ knowledge }: { knowledge: Knowledge }) {
  const isAdmin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);

  return (
    <div className="space-y-3">
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add knowledge
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Tags</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Chunks</th>
                <th className="px-4 py-2 font-medium">Active</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {knowledge.documents.map((doc) => (
                <tr key={doc.id} className="border-b last:border-0" data-testid="document-row">
                  <td className="px-4 py-2 font-medium">
                    {doc.title}
                    {doc.fileName && (
                      <div className="text-xs font-normal text-muted-foreground">
                        {doc.fileName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">{docTypeLabel(doc.docType)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {doc.tags.join(", ") || "-"}
                  </td>
                  <td className="px-4 py-2">
                    <IngestStatus status={doc.status} error={doc.error} />
                  </td>
                  <td className="px-4 py-2">{doc.chunkCount}</td>
                  <td className="px-4 py-2">
                    {isAdmin && !doc.assetId ? (
                      <Switch
                        aria-label={`Active: ${doc.title}`}
                        checked={doc.isActive}
                        onCheckedChange={(isActive) =>
                          void attempt(
                            () => knowledge.updateDocument(doc.id, { isActive }),
                            isActive ? "Document activated." : "Document deactivated.",
                          )
                        }
                      />
                    ) : (
                      <span className="text-xs">{doc.isActive ? "Yes" : "No"}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {relDay(doc.updatedAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`View ${doc.title}`}
                      onClick={() => setViewing(doc.id)}
                    >
                      <Eye />
                    </Button>
                    {isAdmin && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Reprocess ${doc.title}`}
                          onClick={() =>
                            void attempt(
                              () => knowledge.reprocess(doc.id),
                              "Queued for reprocessing.",
                            )
                          }
                        >
                          <RefreshCw />
                        </Button>
                        {!doc.assetId && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${doc.title}`}
                            onClick={() => setDeleting(doc)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {knowledge.documents.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No knowledge yet.
                    {isAdmin ? " Add a document or paste text to get started." : ""}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {isAdmin && (
        <AddKnowledgeDialog open={adding} onOpenChange={setAdding} knowledge={knowledge} />
      )}
      <DocumentDialog id={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this document?"
        description={`"${deleting?.title}" and its searchable text will be removed. This can't be undone.`}
        onConfirm={() => {
          const doc = deleting!;
          setDeleting(null);
          void attempt(() => knowledge.removeDocument(doc.id), "Document deleted.");
        }}
      />
    </div>
  );
}

export function AddKnowledgeDialog({
  open,
  onOpenChange,
  knowledge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledge: Pick<Knowledge, "upload" | "createText">;
}) {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [docType, setDocType] = useState<string>("service");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [showProblem, setShowProblem] = useState(false);
  const problem = knowledgeFormProblem({ mode, file, title, text });

  const submit = async () => {
    setShowProblem(true);
    if (problem) return;
    setSaving(true);
    const ok = await attempt(() => {
      if (mode === "text")
        return knowledge.createText({ title: title.trim(), docType, tags: parseTags(tags), text });
      const form = new FormData();
      form.append("file", file!);
      form.append("docType", docType);
      form.append("tags", parseTags(tags).join(","));
      if (title.trim()) form.append("title", title.trim());
      return knowledge.upload(form);
    }, "Added. It will be ready once processing finishes.");
    setSaving(false);
    if (ok) {
      onOpenChange(false);
      setFile(null);
      setTitle("");
      setText("");
      setTags("");
      setShowProblem(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add knowledge</DialogTitle>
          <DialogDescription>
            The AI agent may only state facts found in the knowledge base.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2" role="radiogroup" aria-label="Source">
            {(["file", "text"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? "default" : "outline"}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === "file" ? "Upload a file" : "Paste text"}
              </Button>
            ))}
          </div>
          {mode === "file" ? (
            <Field label="File (PDF, DOCX, PPTX, Markdown or text; max 20 MB)" htmlFor="kb-file">
              <Input
                id="kb-file"
                type="file"
                accept={DOCUMENT_ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          ) : (
            <Field label="Text" htmlFor="kb-text">
              <Textarea
                id="kb-text"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={mode === "file" ? "Title (defaults to the file name)" : "Title"}
            htmlFor="kb-title"
          >
            <Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="kb-type">
              <select
                id="kb-type"
                className={SELECT_CLASS}
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
              >
                {DOC_TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tags (comma-separated)" htmlFor="kb-tags">
              <Input
                id="kb-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="manufacturing, pricing"
              />
            </Field>
          </div>
          {showProblem && problem && (
            <p className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DocumentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useKnowledgeDocument(id);
  const doc = detail.data;
  return (
    <Dialog open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc?.title ?? "Document"}</DialogTitle>
        </DialogHeader>
        {detail.error ? (
          <p className="text-sm text-destructive">{messageFromError(detail.error)}</p>
        ) : !doc ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Type</dt>
              <dd>{docTypeLabel(doc.docType)}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <IngestStatus status={doc.status} error={doc.error} />{" "}
                {doc.error && <span className="text-xs text-destructive">{doc.error}</span>}
              </dd>
              <dt className="text-muted-foreground">Source</dt>
              <dd>
                {doc.fileName ? `${doc.fileName} (${formatBytes(doc.sizeBytes)})` : "Pasted text"}
              </dd>
              <dt className="text-muted-foreground">Chunks</dt>
              <dd>{doc.chunkCount}</dd>
              <dt className="text-muted-foreground">Tags</dt>
              <dd>{doc.tags.join(", ") || "-"}</dd>
              {doc.assetId && (
                <>
                  <dt className="text-muted-foreground">Asset</dt>
                  <dd>Managed from the Assets tab.</dd>
                </>
              )}
            </dl>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                Extracted text
                {doc.extractedTextLength > 5000
                  ? ` (first 5,000 of ${doc.extractedTextLength.toLocaleString()} characters)`
                  : ""}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                {doc.extractedTextPreview ?? "Not processed yet."}
              </pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Assets ---------------------------------------------------------------------

function AssetsTab({ knowledge }: { knowledge: Knowledge }) {
  const isAdmin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeAsset | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">
          The agent may only attach files from this library. For WhatsApp, PDFs work best (max 10
          MB).
        </p>
        {isAdmin && (
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <Plus /> Add asset
          </Button>
        )}
      </div>
      {knowledge.assets.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No assets yet.
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {knowledge.assets.map((asset) => (
          <Card key={asset.id} data-testid="asset-card">
            <CardContent className="space-y-2 p-4 text-sm">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{asset.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {asset.fileName ?? "-"} · {formatBytes(asset.sizeBytes)}
                  </p>
                </div>
                <IngestStatus status={asset.status} error={asset.error} />
              </div>
              <p>
                <span className="text-muted-foreground">Use when: </span>
                {asset.useWhen}
              </p>
              <p className="text-xs text-muted-foreground">
                Channels:{" "}
                {asset.channels.map((c) => (c === "whatsapp" ? "WhatsApp" : "Email")).join(", ")}
                {asset.tags.length > 0 && ` · Tags: ${asset.tags.join(", ")}`}
              </p>
              <div className="flex items-center gap-2 pt-1">
                {asset.downloadUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={asset.downloadUrl} target="_blank" rel="noreferrer">
                      <Download /> Download
                    </a>
                  </Button>
                )}
                {isAdmin ? (
                  <>
                    <label className="ml-auto flex items-center gap-2 text-xs">
                      Active
                      <Switch
                        aria-label={`Active: ${asset.title}`}
                        checked={asset.isActive}
                        onCheckedChange={(isActive) =>
                          void attempt(
                            () => knowledge.updateAsset(asset.id, { isActive }),
                            isActive ? "Asset activated." : "Asset deactivated.",
                          )
                        }
                      />
                    </label>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${asset.title}`}
                      onClick={() => setDeleting(asset)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                ) : (
                  <span className="ml-auto text-xs">{asset.isActive ? "Active" : "Inactive"}</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {isAdmin && <AddAssetDialog open={adding} onOpenChange={setAdding} knowledge={knowledge} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this asset?"
        description={`"${deleting?.title}", its file and its searchable text will be removed.`}
        onConfirm={() => {
          const asset = deleting!;
          setDeleting(null);
          void attempt(() => knowledge.removeAsset(asset.id), "Asset deleted.");
        }}
      />
    </div>
  );
}

function AddAssetDialog({
  open,
  onOpenChange,
  knowledge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledge: Knowledge;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [useWhen, setUseWhen] = useState("");
  const [tags, setTags] = useState("");
  const [channels, setChannels] = useState<string[]>(["email", "whatsapp"]);
  const [saving, setSaving] = useState(false);
  const [showProblem, setShowProblem] = useState(false);
  const problem = assetFormProblem({ file, title, useWhen, channels });
  const toggle = (channel: string) =>
    setChannels((current) =>
      current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel],
    );

  const submit = async () => {
    setShowProblem(true);
    if (problem) return;
    setSaving(true);
    const form = new FormData();
    form.append("file", file!);
    form.append("title", title.trim());
    form.append("useWhen", useWhen.trim());
    form.append("tags", parseTags(tags).join(","));
    form.append("channels", channels.join(","));
    const ok = await attempt(() => knowledge.createAsset(form), "Asset added.");
    setSaving(false);
    if (ok) {
      onOpenChange(false);
      setFile(null);
      setTitle("");
      setUseWhen("");
      setTags("");
      setShowProblem(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add asset</DialogTitle>
          <DialogDescription>For WhatsApp, PDFs work best (max 10 MB).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="File (PDF, PPTX, DOCX, PNG or JPEG; max 10 MB)" htmlFor="asset-file">
            <Input
              id="asset-file"
              type="file"
              accept={ASSET_ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label="Title" htmlFor="asset-title">
            <Input id="asset-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Use when" htmlFor="asset-use-when">
            <Textarea
              id="asset-use-when"
              rows={2}
              value={useWhen}
              onChange={(e) => setUseWhen(e.target.value)}
              placeholder="The lead asks for proof from a similar manufacturing client"
            />
          </Field>
          <Field label="Tags (comma-separated)" htmlFor="asset-tags">
            <Input id="asset-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">Channels</legend>
            <div className="flex gap-4 text-sm">
              {(["email", "whatsapp"] as const).map((channel) => (
                <label key={channel} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={channels.includes(channel)}
                    onChange={() => toggle(channel)}
                  />
                  {channel === "email" ? "Email" : "WhatsApp"}
                </label>
              ))}
            </div>
          </fieldset>
          {showProblem && problem && (
            <p className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? "Adding…" : "Add asset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Test retrieval -------------------------------------------------------------

function where(hit: KnowledgeHit): string {
  const parts = [
    hit.metadata.page ? `Page ${hit.metadata.page}` : "",
    hit.metadata.slide ? `Slide ${hit.metadata.slide}` : "",
    hit.metadata.heading ?? "",
  ];
  return parts.filter(Boolean).join(" · ");
}

export function RetrievalTab() {
  const search = useKnowledgeSearch();
  const [query, setQuery] = useState("");
  const [docType, setDocType] = useState("");
  const [tags, setTags] = useState("");
  const results = search.data?.data;

  const run = () =>
    search.mutate(
      {
        query,
        ...(docType ? { docTypes: [docType] } : {}),
        ...(parseTags(tags).length ? { tags: parseTags(tags) } : {}),
      },
      { onError: (error) => toast.error(messageFromError(error)) },
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <Field label="Describe a lead or situation" htmlFor="kb-query">
            <Textarea
              id="kb-query"
              rows={3}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Manufacturing company, ₹3 Cr, worried about cost"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Type (optional)" htmlFor="kb-query-type">
              <select
                id="kb-query-type"
                className={SELECT_CLASS}
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
              >
                <option value="">All types</option>
                {[...DOC_TYPE_OPTIONS, ["asset", "Asset"] as const].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tags (optional, comma-separated)" htmlFor="kb-query-tags">
              <Input id="kb-query-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Button disabled={!query.trim() || search.isPending} onClick={run}>
              <Search /> {search.isPending ? "Searching…" : "Search"}
            </Button>
          </div>
        </CardContent>
      </Card>
      {results && results.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No results — add knowledge first.
          </CardContent>
        </Card>
      )}
      {results?.map((hit) => (
        <Card key={hit.chunkId} data-testid="search-result">
          <CardContent className="space-y-2 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{hit.documentTitle}</span>
              <StatusBadge value={docTypeLabel(hit.docType)} tone="neutral" />
              {where(hit) && <span className="text-xs text-muted-foreground">{where(hit)}</span>}
              <span className="ml-auto text-xs text-muted-foreground">
                Score {hit.score.toFixed(3)}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-muted-foreground">{hit.content}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
