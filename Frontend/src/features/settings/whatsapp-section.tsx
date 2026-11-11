import { useQuery } from "@tanstack/react-query";
import { MessageCircle, RefreshCw } from "lucide-react";
import { backend, type WhatsAppConnection } from "@/lib/backend-client";
import { useSearchParam, useSearchTab } from "@/lib/use-search-param";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/crm/section-layout";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { SectionTabs } from "@/components/crm/section-tabs";
import { StatusCard } from "@/components/crm/status-card";
import { keys, messageFromError, useIsAdmin } from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import { WHATSAPP_TABS } from "./settings-search";
import { WhatsAppMonitoring, WhatsAppSafety } from "./whatsapp-safety";
import { WhatsAppNumbers } from "./whatsapp-numbers";

/**
 * Settings → Channels → WhatsApp (UX-1): a status card, then tabs Numbers (the main view; a number opens in a
 * drawer) · Safety & limits · Monitoring. The status polls every 5 s (QR codes, connection states).
 */
export function WhatsAppPanel({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: keys.connection(workspaceId, "whatsapp"),
    queryFn: ({ signal }) => backend.connections.whatsapp.get(signal),
    refetchInterval: 5_000,
  });
  const [tab, setTab] = useSearchTab(WHATSAPP_TABS);
  const data = query.data;
  if (!data)
    return query.isError ? (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          Couldn't load WhatsApp status: {messageFromError(query.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    ) : (
      <SectionSkeleton label="Loading WhatsApp status" />
    );

  return (
    <div className="space-y-6">
      <WhatsAppStatusCard data={data} onOpenSafety={() => setTab("safety")} />
      <SectionTabs
        label="WhatsApp settings"
        value={tab}
        onValueChange={(t) => setTab(t as (typeof WHATSAPP_TABS)[number])}
        tabs={[
          {
            id: "numbers",
            label: "Numbers",
            content: <WhatsAppNumbers workspaceId={workspaceId} data={data} />,
          },
          {
            id: "safety",
            label: "Safety & limits",
            content: <WhatsAppSafety workspaceId={workspaceId} data={data} />,
          },
          {
            id: "monitoring",
            label: "Monitoring",
            content: <WhatsAppMonitoring workspaceId={workspaceId} data={data} />,
          },
        ]}
      />
    </div>
  );
}

function WhatsAppStatusCard({
  data,
  onOpenSafety,
}: {
  data: WhatsAppConnection;
  onOpenSafety: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [, openNumber] = useSearchParam("number");
  const connected = data.numbers.filter((n) => n.status === "connected");
  const paused = data.numbers.filter((n) => n.pause);
  const cap = connected.reduce((sum, n) => sum + n.effectiveDailyCap, 0);
  const common = {
    title: "WhatsApp",
    icon: MessageCircle,
    metric: { label: "Sent today", value: cap ? `${data.todayCount} / ${cap}` : data.todayCount },
  };
  const open = (id: string) => openNumber(id, { replace: false });
  if (!data.enabled)
    return (
      <StatusCard
        {...common}
        tone="danger"
        status="Outbound off"
        detail="WhatsApp outbound is switched off for this workspace: no number sends."
        action={
          isAdmin && (
            <Button variant="outline" onClick={onOpenSafety}>
              Open safety & limits
            </Button>
          )
        }
      />
    );
  if (paused.length)
    return (
      <StatusCard
        {...common}
        tone="danger"
        status="Paused"
        detail={`${paused.map((n) => n.label).join(", ")} ${paused.length === 1 ? "is" : "are"} paused: ${paused[0]!.pause?.reason ?? "sending is turned off"}.`}
        action={
          <Button variant="outline" onClick={() => open(paused[0]!.id)}>
            Open {paused[0]!.label}
          </Button>
        }
      />
    );
  if (data.numbers.length === 0)
    return (
      <StatusCard
        {...common}
        tone="warning"
        status="Not set up"
        detail={
          isAdmin
            ? "Add a number and scan its QR code to start."
            : "Ask an admin to add a WhatsApp number."
        }
      />
    );
  if (connected.length === 0) {
    const first = data.numbers[0]!;
    return (
      <StatusCard
        {...common}
        tone="warning"
        status="Needs attention"
        detail="No number is connected; WhatsApp messages wait until one is."
        action={<Button onClick={() => open(first.id)}>Connect {first.label}</Button>}
      />
    );
  }
  return (
    <StatusCard
      {...common}
      tone={connected.length < data.numbers.length ? "warning" : "success"}
      status={connected.length < data.numbers.length ? "Needs attention" : "Connected"}
      detail={`${connected.length} of ${data.numbers.length} numbers connected.`}
    />
  );
}

/** Settings → Channels → WhatsApp. */
export function WhatsAppSection() {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <>
      <SectionHeader
        title="WhatsApp"
        description="Unofficial WhatsApp Web connection. Use opted-in, dedicated business accounts; each number pairs with its own QR code."
      />
      {currentWorkspaceId && <WhatsAppPanel workspaceId={currentWorkspaceId} />}
    </>
  );
}
