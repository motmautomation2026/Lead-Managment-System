import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/crm/status-pill";
import { fmtDateTime } from "@/lib/format";
import { messageFromError, useLatestReplyDraft, useReplyDraftActions } from "@/store";
import type { ReplyDraft } from "@/types";

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * E3b-2a: the AI's suggested answer to a lead's reply. The owner or an admin edits it and sends
 * it (queued: the worker sends it in the channel's send window, with every safety check) or
 * discards it. The AI never sends it by itself.
 */
export function SuggestedReplyCard({ contactId, draft }: { contactId: string; draft: ReplyDraft }) {
  const [body, setBody] = useState(draft.body ?? "");
  const { send, discard } = useReplyDraftActions(contactId);
  const channel = draft.channel === "email" ? "email" : "WhatsApp";
  const fieldId = `suggested-reply-${draft.id}`;

  if (draft.status !== "open") return <SentReply draft={draft} channel={channel} />;

  const busy = send.isPending || discard.isPending;
  const onSend = () =>
    send.mutate(
      { draftId: draft.id, body },
      {
        onSuccess: (sent) =>
          toast.success(
            sent.sendAt && new Date(sent.sendAt).getTime() > Date.now() + 60_000
              ? `Reply queued. Will send at ${fmtDateTime(sent.sendAt)}.`
              : "Reply queued. It goes out in a few minutes.",
          ),
        onError: (error) => toast.error(messageFromError(error)),
      },
    );
  const onDiscard = () =>
    discard.mutate(draft.id, {
      onSuccess: () => toast.success("Suggested reply discarded."),
      onError: (error) => toast.error(messageFromError(error)),
    });

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={fieldId} className="type-small font-medium">
          Suggested reply
        </Label>
        <StatusPill tone="primary">AI draft · {channel}</StatusPill>
      </div>
      {draft.subject && (
        <p className="type-small break-words text-muted-foreground">Subject: {draft.subject}</p>
      )}
      <Textarea
        id={fieldId}
        value={body}
        rows={draft.channel === "email" ? 6 : 4}
        disabled={!draft.canSend || busy}
        onChange={(e) => setBody(e.target.value)}
      />
      <p className="type-small text-muted-foreground">
        {words(body)} words. Your signature
        {draft.channel === "email" ? " (and your booking link when it offers a call)" : ""} is added
        when it is sent.
      </p>
      {draft.canSend && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onSend} disabled={busy || !body.trim()}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
          <Button size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

/** The reply task's Sheet: the contact's open (else latest sent) suggested reply; nothing for others than the owner and admins. */
export function LatestSuggestedReply({ contactId }: { contactId: string }) {
  const query = useLatestReplyDraft(contactId, true);
  const draft = query.data?.draft;
  // Keyed by id so a new draft (a newer reply) starts from its own text.
  return draft ? <SuggestedReplyCard key={draft.id} contactId={contactId} draft={draft} /> : null;
}

function SentReply({ draft, channel }: { draft: ReplyDraft; channel: string }) {
  if (draft.status !== "sent") return null;
  const state =
    draft.sendStatus === "sent"
      ? `Sent ${fmtDateTime(draft.sentAt ?? undefined)}`
      : draft.sendStatus === "failed" || draft.sendStatus === "cancelled"
        ? `Not sent: ${draft.sendError ?? "the send failed"}`
        : draft.sendAt
          ? `Will send at ${fmtDateTime(draft.sendAt)}`
          : "Sending…";
  return (
    <div className="mt-2 space-y-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-small font-medium">Reply on {channel}</span>
        <StatusPill
          tone={
            draft.sendStatus === "sent"
              ? "success"
              : draft.sendStatus === "failed" || draft.sendStatus === "cancelled"
                ? "danger"
                : "neutral"
          }
        >
          {state}
        </StatusPill>
      </div>
      <p className="type-body break-words whitespace-pre-wrap">{draft.sentBody}</p>
      <p className="type-small text-muted-foreground">
        Suggested reply{draft.edited ? ", edited" : ""}, sent by {draft.sentByName ?? "a rep"}
      </p>
    </div>
  );
}
