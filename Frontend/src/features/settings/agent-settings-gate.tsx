import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentSettings } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { messageFromError, useAgentSettings } from "@/store";

/** Loads the AI agent settings once for an AI section: skeleton, error with Retry, then the section. */
export function WithAgentSettings({
  children,
}: {
  children: (settings: AgentSettings) => ReactNode;
}) {
  const settings = useAgentSettings();
  if (settings.isError)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-destructive">
          Couldn't load the AI agent settings: {messageFromError(settings.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void settings.refetch()}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    );
  if (!settings.data) return <SectionSkeleton label="Loading AI agent settings" />;
  return <>{children(settings.data)}</>;
}
