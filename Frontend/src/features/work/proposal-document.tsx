import { FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { backend } from "@/lib/backend-client";
import { messageFromError } from "@/store";

/**
 * Opens a proposal's file: fetches a 5-minute signed URL on click (never cached or stored)
 * and loads it in a tab opened synchronously, so popup blockers allow it.
 */
async function openProposalDocument(id: string) {
  const tab = window.open("", "_blank");
  try {
    const { url } = await backend.proposals.document(id);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (error) {
    tab?.close();
    toast.error(messageFromError(error));
  }
}

/** "View document" for a proposal with a file (Sheet, record rows); nothing when it has none. */
export function ViewDocumentButton({
  proposal,
  className,
}: {
  proposal: { id: string; title: string; fileName?: string | undefined };
  className?: string;
}) {
  if (!proposal.fileName) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      aria-label={`View document of ${proposal.title}`}
      onClick={(e) => {
        e.stopPropagation();
        void openProposalDocument(proposal.id);
      }}
    >
      <FileText /> View document
    </Button>
  );
}
