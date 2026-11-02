import { useEffect, useState } from "react";
import { BookOpen, History, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type {
  AgentLiveScope,
  AgentMode,
  AgentPlaybook,
  AgentSettings,
  AgentSettingsUpdate,
} from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { LIVE_SCOPE_LABEL } from "@/features/agent/agent-labels";
import { GatePanel, LiveBanner, LiveConfirmDialog } from "@/features/agent/live-mode";
import { MessageRulesCard } from "./message-rules-card";
import { StyleExamplesCard } from "./style-examples-card";
import {
  messageFromError,
  useAgentPlaybooks,
  useAgentSettings,
  useAgentStats,
  useIsAdmin,
  useRestorePlaybook,
  useSavePlaybook,
  useSession,
  useUpdateAgentSettings,
  useResetReadiness,
} from "@/store";

const MODE_HELP: Record<AgentMode, string> = {
  off: "Off: the AI does nothing. Leads keep their AI status, but nothing is drafted or sent.",
  shadow:
    "Shadow: the AI reads enrolled leads and drafts the message it would send, for you to review. Nothing is sent to leads.",
  live: "Live: the AI really sends WhatsApp and email to the contacts in the live scope (only within the send window and safety limits). Every other AI contact keeps getting drafts.",
};
const MODE_LABEL: Record<AgentMode, string> = { off: "Off", shadow: "Shadow", live: "Live" };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type NumberField =
  | "minGapHours"
  | "maxTouches7d"
  | "maxTouchesTotal"
  | "wakeMinDays"
  | "wakeMaxDays"
  | "repQuietHours"
  | "monthlyBudgetUsd"
  | "maxDecisionsPerDay";

const NUMBER_FIELDS: { key: NumberField; label: string; step?: string }[] = [
  { key: "minGapHours", label: "Minimum gap between messages (hours)" },
  { key: "maxTouches7d", label: "Max messages per 7 days" },
  { key: "maxTouchesTotal", label: "Max messages in total" },
  { key: "wakeMinDays", label: "Check back after at least (days)" },
  { key: "wakeMaxDays", label: "Check back after at most (days)" },
  { key: "repQuietHours", label: "Wait after a rep's call or note (hours)" },
  { key: "monthlyBudgetUsd", label: "Monthly budget (USD)", step: "0.01" },
  { key: "maxDecisionsPerDay", label: "Max AI decisions per day" },
];

const STARTER_PLAYBOOK = `# Who we are
One or two lines about the company and who it helps.

# Our services
The services we offer, one line each.

# Goal of every conversation
What a good next step looks like (e.g. book a call with the rep).

# Tone (write as the salesperson)
How the messages should sound, written in the first person as the lead's rep.

# Language
Which language(s) to write in, and when to switch.

# When to hand off to the rep
Situations where the AI should stop and pass the lead to a person.

# When to stop
Signals that the lead isn't interested and should not be contacted again.

# Never say or promise
Topics, prices, guarantees or claims the AI must never make.

# Approved claims and proof points
Facts, results and case studies the AI may quote.
`;

/** Settings → AI agent. Admins edit everything; others see only the message rules, read-only (E2b). */
export function AgentPanel() {
  return useIsAdmin() ? <AgentEditor /> : <MessageRulesReadOnly />;
}

function MessageRulesReadOnly() {
  const stats = useAgentStats();
  if (stats.isError) {
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-sm">
          <p className="text-destructive">
            Couldn't load the AI message rules: {messageFromError(stats.error)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void stats.refetch()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!stats.data) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Loading AI message rules…
        </CardContent>
      </Card>
    );
  }
  return stats.data.messageRules ? (
    <div className="space-y-6">
      <MessageRulesCard rules={stats.data.messageRules} editable={false} />
      <StyleExamplesCard examples={stats.data.messageRules.styleExamples} editable={false} />
    </div>
  ) : null;
}

function AgentEditor() {
  const settings = useAgentSettings();
  if (settings.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles /> AI agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-destructive">
            Couldn't load the AI agent settings: {messageFromError(settings.error)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void settings.refetch()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!settings.data) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Loading AI agent settings…
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <ModeCard settings={settings.data} />
      <LimitsCard settings={settings.data} />
      <MessageRulesCard rules={settings.data} editable />
      <PlaybookCard />
      <StyleExamplesCard examples={settings.data.styleExamples} editable />
    </div>
  );
}

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

type LimitsForm = Record<NumberField, string> & {
  sendDays: number[];
  sendWindowStart: string;
  sendWindowEnd: string;
  nurtureLongTerm: boolean;
  autoEnrollNewLeads: boolean;
  companyDisplayName: string;
  decisionModel: string;
  groundingModel: string;
  emailOptOutText: string;
  whatsappOptOutText: string;
};

function formFrom(settings: AgentSettings): LimitsForm {
  const numbers = Object.fromEntries(
    NUMBER_FIELDS.map(({ key }) => [key, String(settings[key])]),
  ) as Record<NumberField, string>;
  return {
    ...numbers,
    sendDays: settings.sendDays,
    sendWindowStart: settings.sendWindowStart,
    sendWindowEnd: settings.sendWindowEnd,
    nurtureLongTerm: settings.nurtureLongTerm,
    autoEnrollNewLeads: settings.autoEnrollNewLeads,
    companyDisplayName: settings.companyDisplayName ?? "",
    decisionModel: settings.decisionModel ?? "",
    groundingModel: settings.groundingModel ?? "",
    emailOptOutText: settings.emailOptOutText,
    whatsappOptOutText: settings.whatsappOptOutText,
  };
}

// The server validates every value; this only converts the input types.
function toUpdate(form: LimitsForm): AgentSettingsUpdate {
  const numbers = Object.fromEntries(
    NUMBER_FIELDS.map(({ key }) => [key, form[key].trim() === "" ? null : Number(form[key])]),
  );
  return {
    ...numbers,
    sendDays: form.sendDays,
    sendWindowStart: form.sendWindowStart,
    sendWindowEnd: form.sendWindowEnd,
    nurtureLongTerm: form.nurtureLongTerm,
    autoEnrollNewLeads: form.autoEnrollNewLeads,
    companyDisplayName: form.companyDisplayName.trim() || null,
    decisionModel: form.decisionModel.trim() || null,
    groundingModel: form.groundingModel.trim() || null,
    emailOptOutText: form.emailOptOutText,
    whatsappOptOutText: form.whatsappOptOutText,
  } as AgentSettingsUpdate;
}

function LimitsCard({ settings }: { settings: AgentSettings }) {
  const update = useUpdateAgentSettings();
  const { userName } = useSession();
  const [form, setForm] = useState(() => formFrom(settings));
  useEffect(() => setForm(formFrom(settings)), [settings]);
  const set = <K extends keyof LimitsForm>(key: K, value: LimitsForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const toggleDay = (day: number, on: boolean) =>
    set(
      "sendDays",
      on
        ? [...new Set([...form.sendDays, day])].sort((a, b) => a - b)
        : form.sendDays.filter((d) => d !== day),
    );

  const save = () =>
    update.mutate(toUpdate(form), {
      onSuccess: () => toast.success("AI agent limits saved."),
      onError: (error) => toast.error(messageFromError(error)),
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal /> AI agent limits
        </CardTitle>
        <CardDescription>
          When and how often the AI may contact a lead. Times are India Standard Time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Send days</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {DAYS.map((name, index) => {
              const day = index + 1;
              return (
                <label key={name} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={form.sendDays.includes(day)}
                    onCheckedChange={(checked) => toggleDay(day, checked === true)}
                    aria-label={name}
                  />
                  {name}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="agent-window-start">Send window start (IST)</Label>
            <Input
              id="agent-window-start"
              type="time"
              value={form.sendWindowStart}
              onChange={(e) => set("sendWindowStart", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-window-end">Send window end (IST)</Label>
            <Input
              id="agent-window-end"
              type="time"
              value={form.sendWindowEnd}
              onChange={(e) => set("sendWindowEnd", e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBER_FIELDS.map(({ key, label, step }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`agent-${key}`}>{label}</Label>
              <Input
                id={`agent-${key}`}
                type="number"
                inputMode="decimal"
                step={step ?? "1"}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              Nurture Long-Term Nurture leads
              <span className="block text-xs text-muted-foreground">
                Off: moving a lead to Long-Term Nurture stops the AI for it.
              </span>
            </span>
            <Switch
              checked={form.nurtureLongTerm}
              onCheckedChange={(value) => set("nurtureLongTerm", value)}
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              Auto-enroll new leads
              <span className="block text-xs text-muted-foreground">
                New leads (manual, CSV, website) are enrolled in the AI when it isn't off.
              </span>
            </span>
            <Switch
              checked={form.autoEnrollNewLeads}
              onCheckedChange={(value) => set("autoEnrollNewLeads", value)}
            />
          </label>
        </div>

        <div className="space-y-1">
          <Label htmlFor="agent-company-name">Company name used in AI messages</Label>
          <Input
            id="agent-company-name"
            placeholder="Workspace name"
            value={form.companyDisplayName}
            onChange={(e) => set("companyDisplayName", e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="agent-decision-model">Decision model</Label>
            <Input
              id="agent-decision-model"
              placeholder="Server default"
              value={form.decisionModel}
              onChange={(e) => set("decisionModel", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-grounding-model">Grounding model</Label>
            <Input
              id="agent-grounding-model"
              placeholder="Server default"
              value={form.groundingModel}
              onChange={(e) => set("groundingModel", e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            A model name; GPT-5 models can add a reasoning effort, e.g. gpt-5.4-mini@low.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="agent-email-opt-out">Email opt-out text</Label>
            <Textarea
              id="agent-email-opt-out"
              rows={2}
              value={form.emailOptOutText}
              onChange={(e) => set("emailOptOutText", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-whatsapp-opt-out">WhatsApp opt-out text</Label>
            <Textarea
              id="agent-whatsapp-opt-out"
              rows={2}
              value={form.whatsappOptOutText}
              onChange={(e) => set("whatsappOptOutText", e.target.value)}
            />
          </div>
        </div>

        {update.isError && (
          <p className="text-sm text-destructive" role="alert">
            {messageFromError(update.error)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Last updated
            {settings.updatedBy ? ` by ${userName(settings.updatedBy)}` : ""} at{" "}
            {fmtDateTime(settings.updatedAt)}
          </p>
          <Button className="ml-auto" onClick={save} disabled={update.isPending}>
            Save limits
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const byline = (playbook: AgentPlaybook) =>
  `${playbook.createdByName ?? "Unknown"} · ${fmtDateTime(playbook.createdAt)}`;

function PlaybookCard() {
  const playbooks = useAgentPlaybooks();
  const save = useSavePlaybook();
  const restore = useRestorePlaybook();
  const versions = playbooks.data?.data ?? [];
  const current = versions.find((p) => p.version === playbooks.data?.currentVersion) ?? versions[0];
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState<AgentPlaybook | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  useEffect(() => setDraft(current?.body ?? ""), [current?.id, current?.body]);

  const unchanged = draft === (current?.body ?? "");
  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.success("Playbook saved as a new version."),
      onError: (error) => toast.error(messageFromError(error)),
    });
  const onRestore = () => {
    if (!viewing) return;
    restore.mutate(viewing.version, {
      onSuccess: () => {
        toast.success(`Version ${viewing.version} restored as a new version.`);
        setConfirmRestore(false);
        setViewing(null);
      },
      onError: (error) => toast.error(messageFromError(error)),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen /> AI agent playbook
        </CardTitle>
        <CardDescription>
          What the AI should know and how it should behave. Every save creates a new version.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {playbooks.isError ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              Couldn't load the playbook: {messageFromError(playbooks.error)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void playbooks.refetch()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : !playbooks.data ? (
          <p className="text-sm text-muted-foreground">Loading playbook…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {current ? (
                  <>
                    <strong>Version {current.version}</strong>
                    <span className="text-muted-foreground"> · {byline(current)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No playbook yet.</span>
                )}
              </p>
              {!current && (
                <Button size="sm" variant="outline" onClick={() => setDraft(STARTER_PLAYBOOK)}>
                  Insert starter template
                </Button>
              )}
            </div>
            <Textarea
              aria-label="Playbook"
              className="min-h-80 font-mono text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={onSave} disabled={unchanged || !draft.trim() || save.isPending}>
                Save as new version
              </Button>
            </div>

            {versions.length > 0 && (
              <div className="space-y-2 border-t pt-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <History className="size-4" /> History
                </p>
                <ul className="divide-y rounded-md border">
                  {versions.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50",
                          viewing?.id === p.id && "bg-muted",
                        )}
                        onClick={() => setViewing(viewing?.id === p.id ? null : p)}
                      >
                        <span>
                          Version {p.version}
                          {p.version === current?.version && (
                            <span className="ml-2 text-xs text-muted-foreground">(current)</span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{byline(p)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {viewing && (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">Version {viewing.version} (read-only)</p>
                    <Textarea
                      aria-label={`Playbook version ${viewing.version}`}
                      className="min-h-60 font-mono text-sm"
                      value={viewing.body}
                      readOnly
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
                        Close
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restore.isPending}
                        onClick={() => setConfirmRestore(true)}
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={setConfirmRestore}
        title={`Restore version ${viewing?.version ?? ""}?`}
        description="This saves a copy of that version as a new version and makes it current. History is kept."
        confirmLabel="Restore"
        confirmVariant="default"
        disabled={restore.isPending}
        onConfirm={onRestore}
      />
    </Card>
  );
}
