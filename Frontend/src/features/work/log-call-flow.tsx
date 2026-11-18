import { useState } from "react";
import { LogCallDialog } from "@/features/leads/log-call-dialog";
import { EnrollWorkflowDialog } from "@/features/leads/scheduled-followups";
import type { WorkflowTrigger } from "@/types";
import { ScheduleMeetingFlow } from "./schedule-meeting-flow";

/**
 * The one place LogCallDialog is mounted (B12): a nurture outcome prompts for a workflow,
 * Positive / Meeting Agreed open Schedule meeting and — Meeting Agreed — enroll only after the
 * meeting is saved (scheduling cancels the contact's runs). Used by the contact record, the
 * deal record and the Tasks page, so every call prompts the same way.
 */
export function LogCallFlow({
  leadId,
  taskId,
  dealId,
  open,
  onOpenChange,
  onLogged,
}: {
  leadId: string;
  /** Saving the call also completes this open call task. */
  taskId?: string | undefined;
  /** A prompted meeting attaches to this deal (deal record). */
  dealId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** UX-3: the call was saved. */
  onLogged?: (() => void) | undefined;
}) {
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<WorkflowTrigger | undefined>(undefined);
  const [enroll, setEnroll] = useState<{ open: boolean; trigger?: WorkflowTrigger | undefined }>({
    open: false,
  });

  return (
    <>
      {/* Each dialog mounts only while open (nothing is fetched for a closed flow); the flow itself
          stays mounted so a prompt can follow the call dialog closing. */}
      {open && (
        <LogCallDialog
          leadId={leadId}
          taskId={taskId}
          open
          onOpenChange={onOpenChange}
          onLogged={onLogged}
          onEnrollPrompt={(trigger) => setEnroll({ open: true, trigger })}
          onScheduleMeetingPrompt={(trigger) => {
            setPendingTrigger(trigger);
            setMeetingOpen(true);
          }}
        />
      )}
      {meetingOpen && (
        <ScheduleMeetingFlow
          leadId={leadId}
          dealId={dealId}
          open
          onOpenChange={(value) => {
            setMeetingOpen(value);
            // onScheduled already holds the trigger of the save in flight.
            if (!value) setPendingTrigger(undefined);
          }}
          onScheduled={() => {
            if (pendingTrigger) setEnroll({ open: true, trigger: pendingTrigger });
            setPendingTrigger(undefined);
          }}
        />
      )}
      {enroll.open && (
        <EnrollWorkflowDialog
          leadId={leadId}
          open
          onOpenChange={(value) =>
            setEnroll((e) => (value ? { ...e, open: true } : { open: false }))
          }
          {...(enroll.trigger ? { triggerFilter: enroll.trigger } : {})}
        />
      )}
    </>
  );
}
