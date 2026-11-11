import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend, type WhatsAppConnection, type WhatsAppSettingsInput } from "@/lib/backend-client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { keys, messageFromError, useIsAdmin } from "@/store";
import { SaveBar } from "@/components/crm/save-bar";
import { DailyTable, SafetyEventsList, Stat } from "./safety-events";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const EVENT_LABELS: Record<WhatsAppConnection["safetyEvents"][number]["kind"], string> = {
  send_failed: "Send failed",
  reconnect_failed: "Connection dropped",
  disconnected: "Disconnected",
  restricted: "Restricted by WhatsApp",
  paused: "Paused",
  resumed: "Resumed",
};

const whole = (min: number, max: number) =>
  z.coerce.number().int("Whole numbers only.").min(min).max(max);

const safetySchema = z
  .object({
    enabled: z.boolean(),
    maxNumbers: whole(1, 20),
    sendWindow: z.object({
      days: z.array(z.number()).min(1, "Pick at least one day."),
      start: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
      end: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
    }),
  })
  .refine((v) => v.sendWindow.start < v.sendWindow.end, {
    message: "The window must start before it ends.",
    path: ["sendWindow", "end"],
  });

const formValues = (data: WhatsAppConnection): WhatsAppSettingsInput => ({
  enabled: data.enabled,
  maxNumbers: data.maxNumbers,
  sendWindow: data.sendWindow,
});

function windowText({ days, start, end }: WhatsAppConnection["sendWindow"]) {
  return `${days.map((d) => DAYS[d - 1]).join(", ")} · ${start}–${end} IST`;
}

/**
 * Settings → Channels → WhatsApp → Safety & limits (E1, E4a, UX-1): the workspace's master switch, send window and
 * max numbers (admins edit with a sticky save bar; others read). Per-number limits live in each number's drawer.
 */
export function WhatsAppSafety({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: WhatsAppConnection;
}) {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const store = (next: WhatsAppConnection) =>
    client.setQueryData(keys.connection(workspaceId, "whatsapp"), next);

  return (
    <section aria-labelledby="whatsapp-safety" className="space-y-4">
      <div>
        <h3 id="whatsapp-safety" className="type-section-title">
          Safety
        </h3>
        <p className="text-xs text-muted-foreground">
          Slower, capped sending keeps each number from being restricted. Workflow and AI messages
          go out only inside the send window; a rep's proposal and meeting messages are not held by
          it.
        </p>
      </div>

      {!data.enabled && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
        >
          WhatsApp outbound is switched off for this workspace: no number sends.
        </div>
      )}

      {isAdmin ? (
        <SafetyForm key={workspaceId} data={data} onSaved={store} />
      ) : (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <ReadOnly label="Outbound (all numbers)" value={data.enabled ? "On" : "Off"} />
          <ReadOnly label="Send window" value={windowText(data.sendWindow)} />
          <ReadOnly label="Max numbers" value={String(data.maxNumbers)} />
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Only admins can change these.
          </p>
        </dl>
      )}
    </section>
  );
}

/** Settings → Channels → WhatsApp → Monitoring: today's counts, the whole safety-event history, 14 days, review. */
export function WhatsAppMonitoring({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: WhatsAppConnection;
}) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sent today (all numbers)" value={String(data.todayCount)} />
        <Stat label="New chats today" value={String(data.newChatsToday)} />
        <Stat label="Send failures (24 h)" value={String(data.failures24h)} />
        <Stat label="STOP replies (24 h)" value={String(data.stops24h)} />
      </dl>
      <p className="type-small text-muted-foreground">
        Pending workflow messages: {data.pendingCount} · Invalid existing phone values:{" "}
        {data.invalidPhoneCount}
      </p>
      {data.inboundReview.length > 0 && (
        <section aria-labelledby="wa-inbound-review" className="space-y-2">
          <h3 id="wa-inbound-review" className="type-section-title">
            Inbound replies needing review
          </h3>
          <ul className="divide-y rounded-lg border">
            {data.inboundReview.map((event) => (
              <li
                key={event.messageId}
                className="flex flex-wrap justify-between gap-2 px-3 py-2 text-xs"
              >
                <span>{event.senderPhoneE164 ?? "Unknown direct sender"}</span>
                <span className="capitalize text-muted-foreground">
                  {event.disposition} · {event.messageType} · {event.matchCount} matches ·{" "}
                  {new Date(event.receivedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <SafetyEventsList
        queryKey={keys.safetyEvents(workspaceId, "whatsapp")}
        fetchPage={(cursor, signal) =>
          backend.connections.whatsapp.safetyEvents({ cursor }, signal)
        }
        labels={EVENT_LABELS}
      />
      <DailyTable
        rows={data.daily}
        columns={[
          { key: "sent", label: "Sent" },
          { key: "failed", label: "Failed" },
          { key: "stops", label: "STOP" },
        ]}
      />
    </div>
  );
}

function SafetyForm({
  data,
  onSaved,
}: {
  data: WhatsAppConnection;
  onSaved: (next: WhatsAppConnection) => void;
}) {
  const form = useForm<WhatsAppSettingsInput>({
    resolver: zodResolver(safetySchema),
    defaultValues: formValues(data),
  });
  const errors = form.formState.errors;
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = form.handleSubmit(async (values) => {
    setSaveError(null);
    try {
      const next = await backend.connections.whatsapp.update(values);
      onSaved(next);
      form.reset(formValues(next));
      toast.success("WhatsApp settings saved.");
    } catch (error) {
      setSaveError(messageFromError(error));
    }
  });
  return (
    <form className="space-y-4" onSubmit={(e) => void save(e)} noValidate>
      <div className="max-w-xs space-y-1">
        <Label htmlFor="wa-maxNumbers" className="text-xs">
          Max WhatsApp numbers
        </Label>
        <Input
          id="wa-maxNumbers"
          type="number"
          inputMode="numeric"
          aria-invalid={Boolean(errors.maxNumbers)}
          {...form.register("maxNumbers")}
        />
        {errors.maxNumbers && (
          <p className="text-xs text-destructive">{errors.maxNumbers.message}</p>
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">
          Send window for workflow and AI messages (IST, all numbers)
        </legend>
        <Controller
          control={form.control}
          name="sendWindow.days"
          render={({ field }) => (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {DAYS.map((name, index) => {
                const day = index + 1;
                return (
                  <label key={name} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      aria-label={name}
                      checked={field.value.includes(day)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked === true
                            ? [...new Set([...field.value, day])].sort((a, b) => a - b)
                            : field.value.filter((d) => d !== day),
                        )
                      }
                    />
                    {name}
                  </label>
                );
              })}
            </div>
          )}
        />
        {errors.sendWindow?.days && (
          <p className="text-xs text-destructive">{errors.sendWindow.days.message}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="wa-window-start" className="text-xs">
              Opens
            </Label>
            <Input id="wa-window-start" type="time" {...form.register("sendWindow.start")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wa-window-end" className="text-xs">
              Closes
            </Label>
            <Input
              id="wa-window-end"
              type="time"
              aria-invalid={Boolean(errors.sendWindow?.end)}
              {...form.register("sendWindow.end")}
            />
            {errors.sendWindow?.end && (
              <p className="text-xs text-destructive">{errors.sendWindow.end.message}</p>
            )}
          </div>
        </div>
      </fieldset>
      <Controller
        control={form.control}
        name="enabled"
        render={({ field }) => (
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
            <span>
              <span className="font-medium">Outbound enabled (all numbers)</span>
              <span className="block text-xs text-muted-foreground">
                Off: no number sends; messages wait.
              </span>
            </span>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label="Outbound enabled (all numbers)"
            />
          </label>
        )}
      />
      <SaveBar
        dirty={form.formState.isDirty}
        saving={form.formState.isSubmitting}
        onSave={() => void save()}
        onDiscard={() => {
          setSaveError(null);
          form.reset(formValues(data));
        }}
        error={saveError}
        saveLabel="Save WhatsApp settings"
      />
    </form>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
