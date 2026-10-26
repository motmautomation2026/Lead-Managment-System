import { Mail, MessageCircle } from "lucide-react";
import { StatusIcon } from "@/features/meetings/meeting-status-icons";
import { isStillSending } from "@/lib/proposal-sending";
import type { ProposalListItem } from "@/types";

/** Email + WhatsApp send status icons (error as tooltip); a send stuck > 2 min says so (B19). */
export function ProposalSendIcons({ proposal: p }: { proposal: ProposalListItem }) {
  const email = p.emailSendStatus !== "not_applicable";
  const whatsapp = p.whatsappSendStatus !== "not_applicable";
  if (!email && !whatsapp) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {email && (
        <StatusIcon icon={Mail} what="Email" status={p.emailSendStatus} error={p.emailSendError} />
      )}
      {whatsapp && (
        <StatusIcon
          icon={MessageCircle}
          what="WhatsApp"
          status={p.whatsappSendStatus}
          error={p.whatsappSendError}
        />
      )}
      {isStillSending(p) && (
        <span className="type-small text-warning-soft-foreground">Still sending — check later</span>
      )}
    </span>
  );
}
