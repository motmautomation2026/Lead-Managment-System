import { useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import { backend } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { keys, messageFromError } from "@/store";
import { WhatsAppSafety } from "./whatsapp-safety";
import { WhatsAppNumbers } from "./whatsapp-numbers";
import { SectionHeader } from "@/components/crm/section-layout";
import { useWorkspace } from "@/store/workspace-context";

export function WhatsAppPanel({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: keys.connection(workspaceId, "whatsapp"),
    queryFn: ({ signal }) => backend.connections.whatsapp.get(signal),
    refetchInterval: 5_000,
  });
  const data = query.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot /> WhatsApp · Baileys
        </CardTitle>
        <CardDescription>
          Unofficial WhatsApp Web connection. Use opted-in, dedicated business accounts for this
          workspace; each number is paired with its own QR code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data ? (
          query.isError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                Couldn't load WhatsApp status: {messageFromError(query.error)}
              </p>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading WhatsApp health…</p>
          )
        ) : (
          <>
            <WhatsAppNumbers workspaceId={workspaceId} data={data} />
            <div className="text-xs text-muted-foreground">
              Pending workflow messages: {data.pendingCount} · Invalid existing phone values:{" "}
              {data.invalidPhoneCount}
            </div>
            <WhatsAppSafety workspaceId={workspaceId} data={data} />
            {data.inboundReview.length > 0 && (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-sm font-medium">Inbound replies needing review</div>
                {data.inboundReview.map((event) => (
                  <div
                    key={event.messageId}
                    className="flex flex-wrap justify-between gap-2 border-t pt-2 text-xs"
                  >
                    <span>{event.senderPhoneE164 ?? "Unknown direct sender"}</span>
                    <span className="capitalize text-muted-foreground">
                      {event.disposition} · {event.messageType} · {event.matchCount} matches ·{" "}
                      {new Date(event.receivedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Channels → WhatsApp. */
export function WhatsAppSection() {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <>
      <SectionHeader
        title="WhatsApp"
        description="This workspace's WhatsApp numbers and safety limits."
      />
      {currentWorkspaceId && <WhatsAppPanel workspaceId={currentWorkspaceId} />}
    </>
  );
}
