import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ContactPicker } from "@/features/contacts/contact-picker";
import { cn } from "@/lib/utils";
import { messageFromError, useLeadMutations } from "@/store";
import type { CallNotConnectedReason, IdName } from "@/types";

const QUICK_CALLS: { reason: CallNotConnectedReason; label: string }[] = [
  { reason: "no_answer", label: "No answer" },
  { reason: "busy", label: "Busy" },
  { reason: "wrong_number", label: "Wrong number" },
];

/**
 * UX-3 composer above a record's Activity feed: a quick note, or a call that did not connect,
 * without a dialog. "Connected…" opens the full Log call dialog (outcome rules live there and in
 * the backend). Company pages pick which of the company's contacts the note is about.
 */
export function RecordComposer({
  contactId,
  companyId,
  dealId,
  callTaskId,
  canCall = true,
  onConnected,
}: {
  /** The contact the note / call is logged on; omitted on a company page (picked here). */
  contactId?: string | undefined;
  /** Company page: the contact picker lists this company's contacts. */
  companyId?: string | undefined;
  /** Deal page: the note shows in the deal's feed too. */
  dealId?: string | undefined;
  /** An open call task the quick call completes (the contact's next action). */
  callTaskId?: string | undefined;
  /** False hides the Call mode (Do Not Contact, or no single contact). */
  canCall?: boolean;
  onConnected?: () => void;
}) {
  const { addNote, logCall } = useLeadMutations();
  const [mode, setMode] = useState<"note" | "call">("note");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<IdName | null>(null);
  const [busy, setBusy] = useState(false);
  const target = contactId ?? picked?.id;
  const callMode = canCall && contactId ? mode : "note";

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      setText("");
    } catch (error) {
      toast.error(messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {canCall && contactId && (
          <div role="group" aria-label="Log" className="flex rounded-md border p-0.5">
            {(["note", "call"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={callMode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-2.5 py-0.5 text-xs font-medium",
                  callMode === m ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                {m === "note" ? "Note" : "Call"}
              </button>
            ))}
          </div>
        )}
        {!contactId && (
          <div className="min-w-56 flex-1">
            <ContactPicker
              value={picked}
              onChange={setPicked}
              companyId={companyId}
              label="Note about"
            />
          </div>
        )}
      </div>
      <Textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={callMode === "note" ? "New note" : "Call notes (optional)"}
        placeholder={callMode === "note" ? "Add a note…" : "Call notes (optional)…"}
        className="min-h-0 resize-y"
      />
      <div className="flex flex-wrap justify-end gap-2">
        {callMode === "note" ? (
          <Button
            size="sm"
            disabled={!text.trim() || !target || busy}
            onClick={() => void run(() => addNote(target!, text.trim(), dealId), "Note added")}
          >
            Add note
          </Button>
        ) : (
          <>
            {QUICK_CALLS.map((c) => (
              <Button
                key={c.reason}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      logCall(contactId!, {
                        connected: false,
                        notConnectedReason: c.reason,
                        notes: text.trim() || undefined,
                        taskId: callTaskId,
                      }),
                    `Call logged: ${c.label}`,
                  )
                }
              >
                {c.label}
              </Button>
            ))}
            <Button size="sm" disabled={busy} onClick={onConnected}>
              Connected…
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
