import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { messageFromError, useUpdateProposal } from "@/store";

/**
 * LL-3b rule 5: a proposal's "Valid until", editable also after sending by the owner or an admin (`canEdit`).
 * PATCH /proposals/:id enforces the same and writes the change to the timeline.
 */
export function ProposalValidUntil({
  proposal,
  canEdit,
}: {
  proposal: { id: string; validUntil?: string | undefined };
  canEdit: boolean;
}) {
  const update = useUpdateProposal();
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <span className="inline-flex items-center gap-2">
        <span>{proposal.validUntil ?? "–"}</span>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setDraft(proposal.validUntil ?? "")}
          >
            Change
          </Button>
        )}
      </span>
    );
  }

  const save = async () => {
    try {
      await update.mutateAsync({ id: proposal.id, input: { validUntil: draft } });
      toast.success("Valid-until date changed.");
      setDraft(null);
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="date"
        aria-label="Valid until"
        className="h-8 w-40"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button
        size="sm"
        className="h-8"
        disabled={!draft || update.isPending}
        onClick={() => void save()}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={() => setDraft(null)}>
        Cancel
      </Button>
    </span>
  );
}
