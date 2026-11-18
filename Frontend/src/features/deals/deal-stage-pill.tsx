import { StatusPill } from "@/components/crm/status-pill";
import type { DealStage } from "@/types";
import { DEAL_STAGE_LABELS, DEAL_STAGE_TONE } from "./deal-labels";

export function DealStagePill({ stage }: { stage: DealStage }) {
  return (
    <StatusPill tone={DEAL_STAGE_TONE[stage]} dot>
      {DEAL_STAGE_LABELS[stage]}
    </StatusPill>
  );
}
