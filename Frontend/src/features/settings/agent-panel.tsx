import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type {
  AgentLiveScope,
  AgentMode,
  AgentSettings,
  AgentSettingsUpdate,
} from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionHeader } from "@/components/crm/section-layout";
import { LIVE_SCOPE_LABEL } from "@/features/agent/agent-labels";
import { GatePanel, LiveBanner, LiveConfirmDialog } from "@/features/agent/live-mode";
import {
  messageFromError,
  useAgentStats,
  useResetReadiness,
  useUpdateAgentSettings,
} from "@/store";
import { WithAgentSettings } from "./agent-settings-gate";

const MODE_HELP: Record<AgentMode, string> = {
  off: "Off: the AI does nothing. Leads keep their AI status, but nothing is drafted or sent.",
  shadow:
    "Shadow: the AI reads enrolled leads and drafts the message it would send, for you to review. Nothing is sent to leads.",
  live: "Live: the AI really sends WhatsApp and email to the contacts in the live scope (only within the send window and safety limits). Every other AI contact keeps getting drafts.",
};
const MODE_LABEL: Record<AgentMode, string> = { off: "Off", shadow: "Shadow", live: "Live" };

const SCOPE_ORDER: AgentLiveScope[] = ["test_contacts", "new_leads", "all"];

function ModeCard({ settings }: { settings: AgentSettings }) {
  const update = useUpdateAgentSettings();
  const resetReadiness = useResetReadiness();
  const stats = useAgentStats();
  const readiness = stats.data?.readiness;
  const [confirmShadow, setConfirmShadow] = useState(false);
  const [confirmLive, setConfirmLive] = useState<AgentLiveScope | null>(null);
  const save = (input: AgentSettingsUpdate, message: string) =>
    update.mutate(input, {
      onSuccess: () => {
        setConfirmShadow(false);
        setConfirmLive(null);
        toast.success(message);
      },
      onError: (error) => toast.error(messageFromError(error)),
    });
  const choose = (mode: AgentMode) => {
    if (mode === settings.mode) return;
    if (mode === "live") setConfirmLive(settings.liveScope);
    // Turning the AI on from Off wakes every enrolled lead: confirm. Live → Shadow only narrows.
    else if (mode === "shadow" && settings.mode === "off") setConfirmShadow(true);
    else
      save(
        { mode },
        mode === "shadow" ? "AI agent is in Shadow mode. Nothing is sent." : "AI agent is off.",
      );
  };
  const chooseScope = (scope: AgentLiveScope) => {
    if (scope === settings.liveScope) return;
    // Wider → confirm with the numbers; narrower takes effect at once (queued sends are cancelled at send time).
    if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(settings.liveScope)) setConfirmLive(scope);
    else save({ liveScope: scope }, `Live scope: ${LIVE_SCOPE_LABEL[scope]}.`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles /> AI agent
        </CardTitle>
        <CardDescription>
          The AI agent follows up with leads you enroll. Enrollment and safety limits are below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.mode === "live" && stats.data?.live && <LiveBanner live={stats.data.live} />}
        <div className="flex flex-wrap gap-2" role="group" aria-label="AI agent mode">
          {(["off", "shadow", "live"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={
                settings.mode === mode ? (mode === "live" ? "destructive" : "default") : "outline"
              }
              aria-pressed={settings.mode === mode}
              disabled={update.isPending}
              onClick={() => choose(mode)}
            >
              {MODE_LABEL[mode]}
            </Button>
          ))}
        </div>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>{MODE_HELP.off}</li>
          <li>{MODE_HELP.shadow}</li>
          <li>{MODE_HELP.live}</li>
        </ul>
        {settings.mode === "live" && (
          <div className="space-y-2">
            <Label id="agent-live-scope">Who is live</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="agent-live-scope">
              {SCOPE_ORDER.map((scope) => {
                const gated = scope !== "test_contacts" && !readiness?.ready;
                return (
                  <Button
                    key={scope}
                    size="sm"
                    variant={settings.liveScope === scope ? "default" : "outline"}
                    aria-pressed={settings.liveScope === scope}
                    disabled={update.isPending || (gated && settings.liveScope !== scope)}
                    title={gated ? "Needs the go-live gate to pass" : undefined}
                    onClick={() => chooseScope(scope)}
                  >
                    {LIVE_SCOPE_LABEL[scope]}
                  </Button>
                );
              })}
            </div>
            {!readiness?.ready && (
              <p className="text-xs text-muted-foreground">
                New leads and all AI contacts unlock when the go-live gate passes. Test contacts are
                the ones an admin marks "AI live test contact" on the contact's AI panel.
              </p>
            )}
          </div>
        )}
        {readiness && (
          <GatePanel
            readiness={readiness}
            readinessSince={settings.readinessSince}
            reset={{
              pending: resetReadiness.isPending,
              onConfirm: () =>
                resetReadiness.mutate(undefined, {
                  onSuccess: () => toast.success("The go-live count starts now."),
                  onError: (error) => toast.error(messageFromError(error)),
                }),
            }}
          />
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmShadow}
        onOpenChange={setConfirmShadow}
        title="Turn on Shadow mode?"
        description={`${settings.activeLeadCount} ${settings.activeLeadCount === 1 ? "lead is" : "leads are"} enrolled in the AI and will be reviewed now. The AI will start drafting messages for them. Nothing is sent to leads in Shadow mode.`}
        confirmLabel="Turn on Shadow"
        confirmVariant="default"
        disabled={update.isPending}
        onConfirm={() => save({ mode: "shadow" }, "AI agent is in Shadow mode.")}
      />
      <LiveConfirmDialog
        scope={confirmLive}
        onOpenChange={(open) => !open && setConfirmLive(null)}
        pending={update.isPending}
        onConfirm={(scope) =>
          save({ mode: "live", liveScope: scope }, `AI agent is Live: ${LIVE_SCOPE_LABEL[scope]}.`)
        }
      />
    </Card>
  );
}

/** Settings → AI → AI agent: mode, live scope and the go-live gate (admins). */
export function AgentModeSection() {
  return (
    <>
      <SectionHeader title="AI agent" description="Off, Shadow or Live, and who is live." />
      <WithAgentSettings>{(s) => <ModeCard settings={s} />}</WithAgentSettings>
    </>
  );
}
