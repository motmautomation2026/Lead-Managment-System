import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { backend, type WhatsAppConnection, type WhatsAppSafetyInput } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { keys, messageFromError, useIsAdmin } from "@/store";

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
    dailyCap: whole(1, 10_000),
    minDelaySeconds: whole(1, 300),
    maxDelaySeconds: whole(1, 600),
    maxNewChatsPerDay: whole(0, 1000),
    sendWindow: z.object({
      days: z.array(z.number()).min(1, "Pick at least one day."),
      start: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
      end: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
    }),
  })
  .refine((v) => v.minDelaySeconds <= v.maxDelaySeconds, {
    message: "The minimum can't be more than the maximum.",
    path: ["maxDelaySeconds"],
  })
  .refine((v) => v.sendWindow.start < v.sendWindow.end, {
    message: "The window must start before it ends.",
    path: ["sendWindow", "end"],
  });

const formValues = (data: WhatsAppConnection): WhatsAppSafetyInput => ({
  enabled: data.enabled,
  dailyCap: data.dailyCap,
  minDelaySeconds: data.minDelaySeconds,
  maxDelaySeconds: data.maxDelaySeconds,
  maxNewChatsPerDay: data.maxNewChatsPerDay,
  sendWindow: data.sendWindow,
});

function windowText({ days, start, end }: WhatsAppConnection["sendWindow"]) {
  return `${days.map((d) => DAYS[d - 1]).join(", ")} · ${start}–${end} IST`;
}

/** Settings → Workspace → WhatsApp → Safety (E1): limits, pause/resume and monitoring. */
export function WhatsAppSafety({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: WhatsAppConnection;
}) {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const [resumeOpen, setResumeOpen] = useState(false);
  const store = (next: WhatsAppConnection) =>
    client.setQueryData(keys.connection(workspaceId, "whatsapp"), next);
  const resume = useMutation({
    mutationFn: backend.connections.whatsapp.resume,
    onSuccess: (next) => {
      setResumeOpen(false);
      store(next);
      toast.success("WhatsApp sending resumed.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });

  const capText =
    data.warmupDay !== null && data.effectiveDailyCap < data.dailyCap
      ? `${data.todayCount} / ${data.effectiveDailyCap} (warm-up day ${data.warmupDay})`
      : `${data.todayCount} / ${data.effectiveDailyCap}`;

  return (
    <section aria-labelledby="whatsapp-safety" className="space-y-4 border-t pt-4">
      <div>
        <h3 id="whatsapp-safety" className="text-sm font-semibold">
          Safety
        </h3>
        <p className="text-xs text-muted-foreground">
          Slower, capped sending keeps this number from being restricted. Workflow messages go out
          only inside the send window; a rep's proposal and meeting messages are not held by it.
        </p>
      </div>

      {data.pause && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <div className="font-medium">WhatsApp sending is paused</div>
              <div>{data.pause.reason ?? "Outbound sending is turned off."}</div>
              {data.pause.at && (
                <div className="text-xs">
                  {new Date(data.pause.at).toLocaleString()}
                  {data.pause.byName ? ` · by ${data.pause.byName}` : " · automatically"}
                </div>
              )}
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setResumeOpen(true)}>
              Resume sending
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sent today" value={capText} />
        <Stat label="New chats today" value={`${data.newChatsToday} / ${data.maxNewChatsPerDay}`} />
        <Stat label="Send failures (24 h)" value={String(data.failures24h)} />
        <Stat label="STOP replies (24 h)" value={String(data.stops24h)} />
      </div>

      {isAdmin ? (
        <SafetyForm key={workspaceId} data={data} onSaved={store} />
      ) : (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <ReadOnly label="Outbound" value={data.enabled ? "On" : "Off"} />
          <ReadOnly
            label="Spacing between sends"
            value={`${data.minDelaySeconds}–${data.maxDelaySeconds} s`}
          />
          <ReadOnly label="Daily cap (IST)" value={String(data.dailyCap)} />
          <ReadOnly label="New chats per day" value={String(data.maxNewChatsPerDay)} />
          <ReadOnly label="Send window" value={windowText(data.sendWindow)} />
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Only admins can change these.
          </p>
        </dl>
      )}

      {data.safetyEvents.length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="text-sm font-medium">Recent safety events</div>
          <ul className="space-y-1">
            {data.safetyEvents.map((event) => (
              <li
                key={`${event.at}-${event.kind}`}
                className="flex flex-wrap justify-between gap-x-2 border-t pt-1 text-xs"
              >
                <span className="font-medium">{EVENT_LABELS[event.kind]}</span>
                <span className="min-w-0 break-words text-muted-foreground">
                  {event.detail ? `${event.detail} · ` : ""}
                  {new Date(event.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="w-full text-xs">
        <caption className="mb-1 text-left text-sm font-medium">Last 14 days</caption>
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 font-normal">Date (IST)</th>
            <th className="py-1 text-right font-normal">Sent</th>
            <th className="py-1 text-right font-normal">Failed</th>
            <th className="py-1 text-right font-normal">STOP</th>
          </tr>
        </thead>
        <tbody>
          {data.daily.map((day) => (
            <tr key={day.date} className="border-t">
              <td className="py-1">{day.date}</td>
              <td className="py-1 text-right tabular-nums">{day.sent}</td>
              <td className="py-1 text-right tabular-nums">{day.failed}</td>
              <td className="py-1 text-right tabular-nums">{day.stops}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title="Resume WhatsApp sending?"
        description="Queued messages will start going out again, with the usual spacing, caps and send window. Check why it was paused first."
        confirmLabel="Resume sending"
        disabled={resume.isPending}
        onConfirm={() => resume.mutate()}
      />
    </section>
  );
}

function SafetyForm({
  data,
  onSaved,
}: {
  data: WhatsAppConnection;
  onSaved: (next: WhatsAppConnection) => void;
}) {
  const form = useForm<WhatsAppSafetyInput>({
    resolver: zodResolver(safetySchema),
    defaultValues: formValues(data),
  });
  const errors = form.formState.errors;
  const save = form.handleSubmit(async (values) => {
    try {
      const next = await backend.connections.whatsapp.update(values);
      onSaved(next);
      form.reset(formValues(next));
      toast.success("WhatsApp safety settings saved.");
    } catch (error) {
      toast.error(messageFromError(error));
    }
  });
  const number = (
    name: "dailyCap" | "minDelaySeconds" | "maxDelaySeconds" | "maxNewChatsPerDay",
    label: string,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`wa-${name}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`wa-${name}`}
        type="number"
        inputMode="numeric"
        aria-invalid={Boolean(errors[name])}
        {...form.register(name)}
      />
      {errors[name] && <p className="text-xs text-destructive">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <form className="space-y-4" onSubmit={(e) => void save(e)} noValidate>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {number("minDelaySeconds", "Min spacing (seconds)")}
        {number("maxDelaySeconds", "Max spacing (seconds)")}
        {number("dailyCap", "Daily cap (IST)")}
        {number("maxNewChatsPerDay", "New chats per day")}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Send window for workflow messages (IST)</legend>
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
      <div className="flex flex-wrap items-center gap-4">
        <Controller
          control={form.control}
          name="enabled"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-label="Outbound enabled"
              />
              Outbound enabled
            </label>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save safety settings
        </Button>
      </div>
    </form>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
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
