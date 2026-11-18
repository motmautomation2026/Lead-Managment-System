import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { fmtDate } from "@/lib/format";
import { messageFromError, useContactAutomation, useSession } from "@/store";
import type { ContactAutomation } from "@/types";

/** REL-1: the backend decides; this shows the state and asks before switching (admins and the contact's owner). */
export function automationText(a: ContactAutomation): string {
  if (a.enabled === true)
    return `On since ${fmtDate(a.setAt ?? undefined)}${a.setByName ? ` by ${a.setByName}` : ""}`;
  if (a.enabled === false)
    return `Off since ${fmtDate(a.setAt ?? undefined)}${a.setByName ? ` by ${a.setByName}` : ""}`;
  return a.automated
    ? `On — new contact (since go-live, ${fmtDate(a.since)})`
    : "Off — contact from before go-live";
}

export function ContactAutomationCard({
  contactId,
  ownerId,
  automation,
}: {
  contactId: string;
  ownerId: string | null;
  automation: ContactAutomation;
}) {
  const { currentUser } = useSession();
  const canEdit =
    currentUser?.role === "Admin" || (currentUser !== null && currentUser.id === ownerId);
  const save = useContactAutomation();
  const [pending, setPending] = useState<boolean | null>(null);

  const apply = async (enabled: boolean) => {
    setPending(null);
    try {
      await save.mutateAsync({ ids: [contactId], enabled });
      toast.success(enabled ? "Automation switched on" : "Automation switched off");
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="type-section-title">Automation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="contact-automation" className="type-body">
            {automationText(automation)}
          </Label>
          <Switch
            id="contact-automation"
            aria-label="Automation"
            checked={automation.automated}
            disabled={!canEdit || save.isPending}
            onCheckedChange={(checked) => setPending(checked)}
          />
        </div>
        <p className="type-caption text-muted-foreground">
          Automatic tasks, reminders, escalations, workflows and AI messages for this contact.
          {!canEdit && " Only an admin or the contact's owner can change it."}
        </p>
      </CardContent>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? "Switch automation on?" : "Switch automation off?"}
        description={
          pending
            ? "Automatic follow-up starts from the next worker run: for example one “Decide the next step” task if the contact has no next action. Nothing from the past is replayed. Paused workflow runs stay paused."
            : "No more automatic tasks, reminders or messages for this contact, and its workflow runs are paused. Messages already sent stay sent."
        }
        confirmLabel={pending ? "Switch on" : "Switch off"}
        confirmVariant={pending ? "default" : "destructive"}
        disabled={save.isPending}
        onConfirm={() => void apply(Boolean(pending))}
      />
    </Card>
  );
}
