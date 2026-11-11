import { useEffect, useState } from "react";
import { BookOpen, History, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { AgentPlaybook } from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { messageFromError, useAgentPlaybooks, useRestorePlaybook, useSavePlaybook } from "@/store";

const STARTER_PLAYBOOK = `# Who we are
One or two lines about the company and who it helps.

# Our services
The services we offer, one line each.

# Goal of every conversation
What a good next step looks like (e.g. book a call with the rep).

# Tone (write as the salesperson)
How the messages should sound, written in the first person as the lead's rep.

# Language
Which language(s) to write in, and when to switch.

# When to hand off to the rep
Situations where the AI should stop and pass the lead to a person.

# When to stop
Signals that the lead isn't interested and should not be contacted again.

# Never say or promise
Topics, prices, guarantees or claims the AI must never make.

# Approved claims and proof points
Facts, results and case studies the AI may quote.
`;

const byline = (playbook: AgentPlaybook) =>
  `${playbook.createdByName ?? "Unknown"} · ${fmtDateTime(playbook.createdAt)}`;

export function PlaybookCard() {
  const playbooks = useAgentPlaybooks();
  const save = useSavePlaybook();
  const restore = useRestorePlaybook();
  const versions = playbooks.data?.data ?? [];
  const current = versions.find((p) => p.version === playbooks.data?.currentVersion) ?? versions[0];
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState<AgentPlaybook | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  useEffect(() => setDraft(current?.body ?? ""), [current?.id, current?.body]);

  const unchanged = draft === (current?.body ?? "");
  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.success("Playbook saved as a new version."),
    });
  const onRestore = () => {
    if (!viewing) return;
    restore.mutate(viewing.version, {
      onSuccess: () => {
        toast.success(`Version ${viewing.version} restored as a new version.`);
        setConfirmRestore(false);
        setViewing(null);
      },
      onError: (error) => toast.error(messageFromError(error)),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen /> AI agent playbook
        </CardTitle>
        <CardDescription>
          What the AI should know and how it should behave. Every save creates a new version.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {playbooks.isError ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              Couldn't load the playbook: {messageFromError(playbooks.error)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void playbooks.refetch()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : !playbooks.data ? (
          <p className="text-sm text-muted-foreground">Loading playbook…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {current ? (
                  <>
                    <strong>Version {current.version}</strong>
                    <span className="text-muted-foreground"> · {byline(current)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No playbook yet.</span>
                )}
              </p>
              {!current && (
                <Button size="sm" variant="outline" onClick={() => setDraft(STARTER_PLAYBOOK)}>
                  Insert starter template
                </Button>
              )}
            </div>
            <Textarea
              aria-label="Playbook"
              className="min-h-80 font-mono text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <SaveBar
              dirty={!unchanged}
              saving={save.isPending}
              disabled={!draft.trim()}
              onSave={onSave}
              onDiscard={() => {
                save.reset();
                setDraft(current?.body ?? "");
              }}
              error={save.isError ? messageFromError(save.error) : undefined}
              message="Unsaved playbook changes"
              saveLabel="Save as new version"
            />

            {versions.length > 0 && (
              <div className="space-y-2 border-t pt-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <History className="size-4" /> History
                </p>
                <ul className="divide-y rounded-md border">
                  {versions.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50",
                          viewing?.id === p.id && "bg-muted",
                        )}
                        onClick={() => setViewing(viewing?.id === p.id ? null : p)}
                      >
                        <span>
                          Version {p.version}
                          {p.version === current?.version && (
                            <span className="ml-2 text-xs text-muted-foreground">(current)</span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{byline(p)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {viewing && (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">Version {viewing.version} (read-only)</p>
                    <Textarea
                      aria-label={`Playbook version ${viewing.version}`}
                      className="min-h-60 font-mono text-sm"
                      value={viewing.body}
                      readOnly
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
                        Close
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restore.isPending}
                        onClick={() => setConfirmRestore(true)}
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={setConfirmRestore}
        title={`Restore version ${viewing?.version ?? ""}?`}
        description="This saves a copy of that version as a new version and makes it current. History is kept."
        confirmLabel="Restore"
        confirmVariant="default"
        disabled={restore.isPending}
        onConfirm={onRestore}
      />
    </Card>
  );
}

/** Settings → AI → Playbook (admins). The history shows the latest 50 versions (API cap). */
export function PlaybookSection() {
  return (
    <>
      <SectionHeader title="Playbook" description="What the AI knows and how it behaves." />
      <PlaybookCard />
    </>
  );
}
