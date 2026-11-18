import { toast } from "sonner";
import {
  ScheduleMeetingDialog,
  type MeetingToEdit,
} from "@/features/meetings/schedule-meeting-dialog";
import { messageFromError, useCreateMeeting, useUpdateMeeting } from "@/store";

/**
 * Schedule (no `meeting`) or reschedule a meeting and save it. No `leadId` = the dialog asks
 * for the contact (ContactPicker). `onScheduled` runs after a successful save.
 */
export function ScheduleMeetingFlow({
  leadId,
  dealId,
  meeting = null,
  open,
  onOpenChange,
  onScheduled,
}: {
  leadId?: string | undefined;
  dealId?: string | undefined;
  meeting?: MeetingToEdit | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScheduled?: () => void;
}) {
  const create = useCreateMeeting();
  const update = useUpdateMeeting();
  return (
    <ScheduleMeetingDialog
      {...(leadId ? { leadId } : {})}
      {...(dealId ? { dealId } : {})}
      meeting={meeting}
      open={open}
      isSaving={create.isPending || update.isPending}
      onOpenChange={onOpenChange}
      onSave={(value) =>
        void (async () => {
          try {
            if (meeting) {
              const { title, at, durationMin, url } = value;
              await update.mutateAsync({
                id: meeting.id,
                input: { title, at, durationMin, url, status: "rescheduled" },
              });
              toast.success("Meeting rescheduled");
            } else {
              await create.mutateAsync(value);
              toast.success("Meeting scheduled");
            }
            onScheduled?.();
          } catch (error) {
            toast.error(messageFromError(error));
          }
        })()
      }
    />
  );
}
