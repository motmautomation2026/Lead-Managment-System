import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentEnrollResult } from "@/lib/backend-client";
import { messageFromError, useEnrollLeads } from "@/store";
import { ENROLL_SKIP_LABEL } from "./agent-labels";

/** Admin: enroll the selected leads in the AI agent, then show what happened. */
export function EnrollInAiDialog({
  leadIds,
  open,
  onOpenChange,
  onDone,
}: {
  leadIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a run finished (e.g. to clear the selection). */
  onDone: () => void;
}) {
  const enroll = useEnrollLeads();
  const [results, setResults] = useState<AgentEnrollResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    setError(null);
    try {
      setResults(await enroll.mutateAsync(leadIds));
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  const close = (value: boolean) => {
    if (enroll.isPending) return;
    onOpenChange(value);
    if (!value) {
      setResults(null);
      setError(null);
    }
  };

  const enrolled = results?.filter((r) => r.result === "enrolled").length ?? 0;
  const skipped = Object.entries(
    (results ?? []).reduce<Record<string, number>>((acc, r) => {
      if (r.result !== "enrolled") {
        const key = r.result === "failed" ? "failed" : r.reason;
        acc[key] = (acc[key] ?? 0) + 1;
      }
      return acc;
    }, {}),
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Enroll in AI</DialogTitle>
        </DialogHeader>
        {results ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              {enrolled} {enrolled === 1 ? "lead" : "leads"} enrolled.
            </p>
            {skipped.length > 0 && (
              <ul className="ml-4 list-disc text-muted-foreground">
                {skipped.map(([reason, count]) => (
                  <li key={reason}>
                    {ENROLL_SKIP_LABEL[reason as keyof typeof ENROLL_SKIP_LABEL] ?? reason}: {count}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              The AI agent will start drafting for {leadIds.length}{" "}
              {leadIds.length === 1 ? "lead" : "leads"}. Leads that can't be enrolled are skipped.
            </p>
            {enroll.isPending && <p className="text-muted-foreground">Enrolling…</p>}
            {error !== null && <p className="text-destructive">{messageFromError(error)}</p>}
          </div>
        )}
        <DialogFooter>
          {results ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={enroll.isPending} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                disabled={enroll.isPending || leadIds.length === 0}
                onClick={() => void run()}
              >
                Enroll {leadIds.length}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
