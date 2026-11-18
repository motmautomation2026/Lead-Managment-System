import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { AgentSettings, AgentSettingsUpdate } from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { messageFromError, useSession, useUpdateAgentSettings } from "@/store";
import { WithAgentSettings } from "./agent-settings-gate";

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

export type LimitsForm = Record<NumberField, string> & {
  sendDays: number[];
  sendWindowStart: string;
  sendWindowEnd: string;
  nurtureLongTerm: boolean;
  autoEnrollNewLeads: boolean;
  firstChannel: AgentSettings["firstChannel"];
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
    firstChannel: settings.firstChannel,
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
    firstChannel: form.firstChannel,
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

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">First message channel</legend>
          <p className="text-xs text-muted-foreground">
            When a contact has both email and WhatsApp, the first AI message uses this channel;
            later messages alternate.
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="First message channel">
            {(["whatsapp", "email"] as const).map((channel) => (
              <Button
                key={channel}
                type="button"
                size="sm"
                variant={form.firstChannel === channel ? "default" : "outline"}
                aria-pressed={form.firstChannel === channel}
                onClick={() => set("firstChannel", channel)}
              >
                {channel === "whatsapp" ? "WhatsApp" : "Email"}
              </Button>
            ))}
          </div>
        </fieldset>

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
              aria-describedby="agent-opt-out-help"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-whatsapp-opt-out">WhatsApp opt-out text</Label>
            <Textarea
              id="agent-whatsapp-opt-out"
              rows={2}
              value={form.whatsappOptOutText}
              onChange={(e) => set("whatsappOptOutText", e.target.value)}
              aria-describedby="agent-opt-out-help"
            />
          </div>
          <p id="agent-opt-out-help" className="text-xs text-muted-foreground sm:col-span-2">
            Leave empty to add no opt-out line.
          </p>
        </div>

        <p className="border-t pt-4 text-xs text-muted-foreground">
          Last updated
          {settings.updatedBy ? ` by ${userName(settings.updatedBy)}` : ""} at{" "}
          {fmtDateTime(settings.updatedAt)}
        </p>
        <SaveBar
          dirty={JSON.stringify(form) !== JSON.stringify(formFrom(settings))}
          saving={update.isPending}
          onSave={save}
          onDiscard={() => {
            update.reset();
            setForm(formFrom(settings));
          }}
          error={update.isError ? messageFromError(update.error) : undefined}
          saveLabel="Save limits"
        />
      </CardContent>
    </Card>
  );
}

/** Settings → AI → Limits & schedule (admins). */
export function AgentLimitsSection() {
  return (
    <>
      <SectionHeader title="Limits & schedule" description="When and how often the AI may write." />
      <WithAgentSettings>{(s) => <LimitsCard settings={s} />}</WithAgentSettings>
    </>
  );
}
