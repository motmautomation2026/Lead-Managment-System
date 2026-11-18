import { useState, type ReactNode } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  backend,
  type DeliverabilityCheck,
  type EmailConnectionTest,
  type EmailSettings,
  type EmailSettingsInput,
} from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { StatusCard } from "@/components/crm/status-card";
import { SectionTabs } from "@/components/crm/section-tabs";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { useSearchTab } from "@/lib/use-search-param";
import { EMAIL_TABS } from "./settings-search";
import { DailyTable, SafetyEventsList, Stat } from "./safety-events";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { keys, messageFromError, useIsAdmin } from "@/store";
import { SectionHeader } from "@/components/crm/section-layout";
import { useWorkspace } from "@/store/workspace-context";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const EVENT_LABELS: Record<EmailSettings["safetyEvents"][number]["kind"], string> = {
  send_failed: "Send failed",
  recipient_rejected: "Recipient rejected",
  login_rejected: "Login rejected",
  rate_limited: "Limited / blocked by the server",
  paused: "Paused",
  resumed: "Resumed",
};

const CHECK_LABELS: Record<DeliverabilityCheck["lines"][number]["check"], string> = {
  mx: "MX",
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
};
const CHECK_TONE: Record<DeliverabilityCheck["lines"][number]["status"], [PillTone, string]> = {
  green: ["success", "OK"],
  amber: ["warning", "Check"],
  red: ["danger", "Missing"],
};

const whole = (min: number, max: number) =>
  z.coerce.number().int("Whole numbers only.").min(min).max(max);
const port = whole(1, 65535);

const emailSchema = z
  .object({
    enabled: z.boolean(),
    smtpHost: z.string().trim().min(1, "The SMTP host is required."),
    smtpPort: port,
    smtpSecurity: z.enum(["ssl", "starttls"]),
    smtpUsername: z.string(),
    smtpPassword: z.string(),
    fromAddress: z.string().trim().email("Enter a valid email address."),
    fromName: z.string().trim().min(1, "The from name is required.").max(120),
    replyTo: z.union([z.literal(""), z.string().trim().email("Enter a valid email address.")]),
    imapHost: z.string().trim().min(1, "The IMAP host is required."),
    imapPort: port,
    imapSecurity: z.enum(["ssl", "starttls"]),
    imapSameLogin: z.boolean(),
    imapUsername: z.string(),
    imapPassword: z.string(),
    imapFolder: z.string().trim().min(1, "The folder is required."),
    dailyCap: whole(1, 10_000),
    hourlyCap: whole(1, 1000),
    minDelaySeconds: whole(1, 3600),
    maxDelaySeconds: whole(1, 3600),
    sendWindow: z.object({
      days: z.array(z.number()).min(1, "Pick at least one day."),
      start: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
      end: z.string().regex(/^\d{2}:\d{2}$/, "Pick a time."),
    }),
    alreadyWarmed: z.boolean(),
  })
  .refine((v) => v.minDelaySeconds <= v.maxDelaySeconds, {
    message: "The minimum can't be more than the maximum.",
    path: ["maxDelaySeconds"],
  })
  .refine((v) => v.sendWindow.start < v.sendWindow.end, {
    message: "The window must start before it ends.",
    path: ["sendWindow", "end"],
  });

/** In the form the secret inputs are always strings ("" = keep the saved one). */
type EmailFormValues = Required<EmailSettingsInput>;

/** The saved values; secrets are never sent to the browser, so their inputs start empty. */
const formValues = (d: EmailSettings): EmailFormValues => ({
  enabled: d.configured ? d.enabled : true,
  smtpHost: d.smtpHost,
  smtpPort: d.smtpPort,
  smtpSecurity: d.smtpSecurity,
  smtpUsername: "",
  smtpPassword: "",
  fromAddress: d.fromAddress,
  fromName: d.fromName,
  replyTo: d.replyTo,
  imapHost: d.imapHost,
  imapPort: d.imapPort,
  imapSecurity: d.imapSecurity,
  imapSameLogin: d.imapSameLogin,
  imapUsername: "",
  imapPassword: "",
  imapFolder: d.imapFolder,
  dailyCap: d.dailyCap,
  hourlyCap: d.hourlyCap,
  minDelaySeconds: d.minDelaySeconds,
  maxDelaySeconds: d.maxDelaySeconds,
  sendWindow: d.sendWindow,
  alreadyWarmed: d.alreadyWarmed,
});

const securityText = (s: string) => (s === "ssl" ? "SSL/TLS" : "STARTTLS");
const windowText = ({ days, start, end }: EmailSettings["sendWindow"]) =>
  `${days.map((d) => DAYS[d - 1]).join(", ")} · ${start}–${end} IST`;

/**
 * Settings → Channels → Email (E1b, UX-1): a status card (state, sent today, the next action), then tabs —
 * Connection (SMTP + IMAP, mailbox checks) · Safety & limits · Replies & bounces · Monitoring · Deliverability.
 * Connection and Safety share one form with a sticky save bar. Every CRM user can read it (never a secret); only
 * admins change, test or resume.
 */
export function EmailPanel({ workspaceId }: { workspaceId: string }) {
  const isAdmin = useIsAdmin();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: keys.connection(workspaceId, "email"),
    queryFn: ({ signal }) => backend.connections.email.get(signal),
  });
  const [resumeOpen, setResumeOpen] = useState(false);
  const store = (next: EmailSettings) =>
    client.setQueryData(keys.connection(workspaceId, "email"), next);
  const resume = useMutation({
    mutationFn: backend.connections.email.resume,
    onSuccess: (next) => {
      setResumeOpen(false);
      store(next);
      toast.success("Email sending resumed.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });

  const data = query.data;
  if (!data)
    return query.isError ? (
      <div className="space-y-2 text-sm">
        <p className="text-destructive">
          Couldn't load the email settings: {messageFromError(query.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    ) : (
      <SectionSkeleton label="Loading email settings" />
    );

  return (
    <EmailView
      key={workspaceId}
      data={data}
      isAdmin={isAdmin}
      workspaceId={workspaceId}
      onSaved={store}
      onResume={() => setResumeOpen(true)}
      resumeDialog={
        <ConfirmDialog
          open={resumeOpen}
          onOpenChange={setResumeOpen}
          title="Resume email sending?"
          description="Queued emails start going out again, with the usual spacing, caps and send window. Check why it was paused first."
          confirmLabel="Resume sending"
          confirmVariant="default"
          disabled={resume.isPending}
          onConfirm={() => resume.mutate()}
        />
      }
    />
  );
}

const EMAIL_TAB_FIELDS: Record<"connection" | "safety", (keyof EmailFormValues)[]> = {
  connection: [
    "smtpHost",
    "smtpPort",
    "smtpSecurity",
    "smtpUsername",
    "smtpPassword",
    "fromAddress",
    "fromName",
    "replyTo",
    "imapHost",
    "imapPort",
    "imapSecurity",
    "imapSameLogin",
    "imapUsername",
    "imapPassword",
    "imapFolder",
  ],
  safety: [
    "minDelaySeconds",
    "maxDelaySeconds",
    "dailyCap",
    "hourlyCap",
    "sendWindow",
    "alreadyWarmed",
    "enabled",
  ],
};

function EmailView({
  data,
  isAdmin,
  workspaceId,
  onSaved,
  onResume,
  resumeDialog,
}: {
  data: EmailSettings;
  isAdmin: boolean;
  workspaceId: string;
  onSaved: (next: EmailSettings) => void;
  onResume: () => void;
  resumeDialog: ReactNode;
}) {
  const tabs = data.imapStatus ? EMAIL_TABS : EMAIL_TABS.filter((t) => t !== "replies");
  const [tab, setTab] = useSearchTab(tabs);
  const form = useForm<EmailFormValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: formValues(data),
  });
  const errors = form.formState.errors;
  const errorCount = (t: "connection" | "safety") =>
    EMAIL_TAB_FIELDS[t].filter((name) => errors[name]).length;
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = form.handleSubmit(
    async (values) => {
      setSaveError(null);
      const input: EmailSettingsInput = { ...values };
      // Blank secrets keep the saved ones.
      for (const key of ["smtpUsername", "smtpPassword", "imapUsername", "imapPassword"] as const) {
        if (!input[key]) delete input[key];
      }
      try {
        const next = await backend.connections.email.update(input);
        onSaved(next);
        form.reset(formValues(next));
        toast.success("Email settings saved.");
      } catch (error) {
        setSaveError(messageFromError(error));
      }
    },
    // Show the tab with the first problem.
    (problems) => {
      const has = (t: "connection" | "safety") => EMAIL_TAB_FIELDS[t].some((n) => problems[n]);
      if (has("connection")) setTab("connection");
      else if (has("safety")) setTab("safety");
    },
  );

  const badge = (t: "connection" | "safety") =>
    errorCount(t) ? (
      <StatusPill tone="danger" className="px-1.5">
        {errorCount(t)}
      </StatusPill>
    ) : null;

  return (
    <div className="space-y-6">
      <EmailStatusCard
        data={data}
        isAdmin={isAdmin}
        onResume={onResume}
        onSetUp={() => {
          setTab("connection");
          requestAnimationFrame(() => document.getElementById("email-smtpHost")?.focus());
        }}
        onOpenTab={setTab}
      />
      <SectionTabs
        label="Email settings"
        value={tab}
        onValueChange={(t) => setTab(t as (typeof EMAIL_TABS)[number])}
        keepMounted={["connection", "safety"]}
        tabs={[
          {
            id: "connection",
            label: "Connection",
            badge: badge("connection"),
            content: isAdmin ? (
              <div className="space-y-6">
                <ConnectionFields form={form} data={data} />
                {data.configured && <ConnectionTests />}
              </div>
            ) : (
              <ReadOnlyConnection data={data} />
            ),
          },
          {
            id: "safety",
            label: "Safety & limits",
            badge: badge("safety"),
            content: isAdmin ? <SafetyFields form={form} /> : <ReadOnlySafety data={data} />,
          },
          ...(data.imapStatus
            ? [
                {
                  id: "replies",
                  label: "Replies & bounces",
                  content: (
                    <RepliesAndBounces
                      status={data.imapStatus}
                      isAdmin={isAdmin}
                      onChecked={onSaved}
                    />
                  ),
                },
              ]
            : []),
          {
            id: "monitoring",
            label: "Monitoring",
            content: <EmailMonitoring data={data} workspaceId={workspaceId} />,
          },
          {
            id: "deliverability",
            label: "Deliverability",
            content: (
              <div className="space-y-6">
                {isAdmin && data.configured && <DeliverabilityCard />}
                <OpenTracking data={data} isAdmin={isAdmin} onSaved={onSaved} />
              </div>
            ),
          },
        ]}
      />
      {isAdmin && (
        <SaveBar
          dirty={form.formState.isDirty}
          saving={form.formState.isSubmitting}
          onSave={() => void save()}
          onDiscard={() => {
            setSaveError(null);
            form.reset(formValues(data));
          }}
          error={
            saveError ??
            (errorCount("connection") + errorCount("safety")
              ? "Fix the highlighted fields first."
              : undefined)
          }
          saveLabel="Save email settings"
        />
      )}
      {resumeDialog}
    </div>
  );
}

function EmailStatusCard({
  data,
  isAdmin,
  onResume,
  onSetUp,
  onOpenTab,
}: {
  data: EmailSettings;
  isAdmin: boolean;
  onResume: () => void;
  onSetUp: () => void;
  onOpenTab: (tab: (typeof EMAIL_TABS)[number]) => void;
}) {
  const capText =
    data.warmupDay !== null && data.effectiveDailyCap < data.dailyCap
      ? `${data.sentToday} / ${data.effectiveDailyCap} (warm-up day ${data.warmupDay})`
      : `${data.sentToday} / ${data.effectiveDailyCap}`;
  const metric = { label: "Sent today", value: capText };
  const common = { title: "Email", icon: Mail, metric };
  if (!data.configured)
    return (
      <StatusCard
        {...common}
        tone="warning"
        status="Not set up"
        detail={
          <>
            {data.legacyProvider === "resend"
              ? "This workspace used Resend, which is no longer supported. "
              : ""}
            {isAdmin
              ? "Add the SMTP mailbox below. Emails wait in the queue until then."
              : "An admin must add the SMTP mailbox here. Emails wait in the queue until then."}
          </>
        }
        action={isAdmin && <Button onClick={onSetUp}>Set up mailbox</Button>}
      />
    );
  if (data.pause)
    return (
      <StatusCard
        {...common}
        tone="danger"
        status="Paused"
        detail={
          <span role="alert">
            Email sending is paused: {data.pause.reason ?? "Sending is turned off."}
            {data.pause.at && (
              <span className="block type-small">
                {new Date(data.pause.at).toLocaleString()}
                {data.pause.byName ? ` · by ${data.pause.byName}` : " · automatically"}
              </span>
            )}
          </span>
        }
        action={
          isAdmin && (
            <Button variant="outline" onClick={onResume}>
              Resume sending
            </Button>
          )
        }
      />
    );
  if (!data.enabled)
    return (
      <StatusCard
        {...common}
        tone="neutral"
        status="Sending off"
        detail="Emails wait in the queue until sending is turned on."
        action={
          isAdmin && (
            <Button variant="outline" onClick={() => onOpenTab("safety")}>
              Open safety & limits
            </Button>
          )
        }
      />
    );
  if (data.imapStatus?.lastError)
    return (
      <StatusCard
        {...common}
        tone="warning"
        status="Needs attention"
        detail={`Replies and bounces can't be read: ${data.imapStatus.lastError}`}
        action={
          <Button variant="outline" onClick={() => onOpenTab("replies")}>
            Open replies & bounces
          </Button>
        }
      />
    );
  return (
    <StatusCard
      {...common}
      tone="success"
      status="Connected"
      detail={`From ${data.fromName} <${data.fromAddress}>`}
    />
  );
}

function EmailMonitoring({ data, workspaceId }: { data: EmailSettings; workspaceId: string }) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sent this hour" value={`${data.sentThisHour} / ${data.hourlyCap}`} />
        <Stat label="Waiting in the queue" value={String(data.queuedCount)} />
        <Stat label="Send failures (24 h)" value={String(data.failures24h)} />
        <Stat label="Rejected by recipient (24 h)" value={String(data.rejections24h)} />
      </dl>
      <SafetyEventsList
        queryKey={keys.safetyEvents(workspaceId, "email")}
        fetchPage={(cursor, signal) => backend.connections.email.safetyEvents({ cursor }, signal)}
        labels={EVENT_LABELS}
      />
      <DailyTable
        rows={data.daily}
        columns={[
          { key: "sent", label: "Sent" },
          { key: "failed", label: "Failed" },
          { key: "rejected", label: "Rejected" },
        ]}
      />
    </div>
  );
}

function ReadOnlyConnection({ data }: { data: EmailSettings }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
      {data.configured ? (
        <>
          <ReadOnly label="From" value={`${data.fromName} <${data.fromAddress}>`} />
          <ReadOnly
            label="SMTP server"
            value={`${data.smtpHost}:${data.smtpPort} (${securityText(data.smtpSecurity)})`}
          />
          <ReadOnly
            label="IMAP server"
            value={
              data.imapHost ? `${data.imapHost}:${data.imapPort} · ${data.imapFolder}` : "Not set"
            }
          />
        </>
      ) : (
        <ReadOnly label="Mailbox" value="Not set up" />
      )}
      <p className="text-xs text-muted-foreground sm:col-span-2">Only admins can change these.</p>
    </dl>
  );
}

function ReadOnlySafety({ data }: { data: EmailSettings }) {
  return (
    <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
      <ReadOnly label="Sending" value={data.enabled ? "On" : "Off"} />
      <ReadOnly
        label="Spacing between emails"
        value={`${data.minDelaySeconds}–${data.maxDelaySeconds} s`}
      />
      <ReadOnly label="Caps" value={`${data.dailyCap} per day · ${data.hourlyCap} per hour`} />
      <ReadOnly label="Send window" value={windowText(data.sendWindow)} />
      <p className="text-xs text-muted-foreground sm:col-span-2">Only admins can change these.</p>
    </dl>
  );
}

function ConnectionFields({ form, data }: { form: FormApi; data: EmailSettings }) {
  const sameLogin = form.watch("imapSameLogin");
  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="type-section-title">Sending (SMTP)</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <TextField form={form} name="smtpHost" label="SMTP host" placeholder="smtp.gmail.com" />
          <TextField form={form} name="smtpPort" label="Port" type="number" />
          <SecurityField
            form={form}
            name="smtpSecurity"
            hint="SSL usually 465, STARTTLS usually 587."
          />
          <SecretField
            form={form}
            name="smtpUsername"
            label="Username"
            saved={data.smtpUsernameConfigured}
            autoComplete="off"
          />
          <SecretField
            form={form}
            name="smtpPassword"
            label="Password or app password"
            saved={data.smtpPasswordConfigured}
            type="password"
          />
          <TextField form={form} name="fromAddress" label="From address" type="email" />
          <TextField form={form} name="fromName" label="Default from name" />
          <TextField
            form={form}
            name="replyTo"
            label="Reply-to (optional)"
            type="email"
            placeholder="Same as the from address"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Emails to a contact go out as "&lt;owner&gt; | &lt;company&gt;"; others use the default
          from name. Passwords are encrypted and never shown again.
        </p>
      </fieldset>

      <fieldset className="space-y-3 border-t pt-5">
        <legend className="type-section-title">Replies and bounces (IMAP)</legend>
        <p className="text-xs text-muted-foreground">
          Every 2 minutes the worker reads new mail in this folder (read-only: nothing is marked
          read, moved or deleted) to record replies, bounces and unsubscribes.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <TextField form={form} name="imapHost" label="IMAP host" placeholder="imap.gmail.com" />
          <TextField form={form} name="imapPort" label="Port" type="number" />
          <SecurityField form={form} name="imapSecurity" hint="SSL usually 993." />
          <TextField form={form} name="imapFolder" label="Folder" />
        </div>
        <Controller
          control={form.control}
          name="imapSameLogin"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
              Same login as SMTP
            </label>
          )}
        />
        {!sameLogin && (
          <div className="grid gap-4 sm:grid-cols-2">
            <SecretField
              form={form}
              name="imapUsername"
              label="IMAP username"
              saved={data.imapUsernameConfigured}
              autoComplete="off"
            />
            <SecretField
              form={form}
              name="imapPassword"
              label="IMAP password"
              saved={data.imapPasswordConfigured}
              type="password"
            />
          </div>
        )}
      </fieldset>
    </div>
  );
}

function SafetyFields({ form }: { form: FormApi }) {
  const errors = form.formState.errors;
  return (
    <div className="space-y-5">
      <Controller
        control={form.control}
        name="enabled"
        render={({ field }) => (
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
            <span>
              <span className="font-medium">Sending enabled</span>
              <span className="block text-xs text-muted-foreground">
                Off: every email waits in the queue.
              </span>
            </span>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label="Sending enabled"
            />
          </label>
        )}
      />
      <p className="text-xs text-muted-foreground">
        Slow, capped sending protects the mailbox's reputation. Workflow emails go out only inside
        the send window; a rep's proposal, meeting and test emails are not held by it.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField form={form} name="minDelaySeconds" label="Min spacing (seconds)" type="number" />
        <TextField form={form} name="maxDelaySeconds" label="Max spacing (seconds)" type="number" />
        <TextField form={form} name="dailyCap" label="Daily cap (IST)" type="number" />
        <TextField form={form} name="hourlyCap" label="Hourly cap" type="number" />
      </div>
      <fieldset className="space-y-2">
        <legend className="type-label">Send window for workflow emails (IST)</legend>
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
            <Label htmlFor="email-window-start" className="text-xs">
              Opens
            </Label>
            <Input id="email-window-start" type="time" {...form.register("sendWindow.start")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email-window-end" className="text-xs">
              Closes
            </Label>
            <Input
              id="email-window-end"
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
        name="alreadyWarmed"
        render={({ field }) => (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
            <span>
              This mailbox is already warmed up (used for normal email for months)
              <span className="block text-xs text-muted-foreground">
                Otherwise a new mailbox sends at most 20 / 40 / 70 a day in its first 3 / 7 / 14
                days.
              </span>
            </span>
          </label>
        )}
      />
    </div>
  );
}

type FormApi = UseFormReturn<EmailFormValues>;
type TextName =
  | "smtpHost"
  | "smtpPort"
  | "fromAddress"
  | "fromName"
  | "replyTo"
  | "imapHost"
  | "imapPort"
  | "imapFolder"
  | "minDelaySeconds"
  | "maxDelaySeconds"
  | "dailyCap"
  | "hourlyCap";

function FieldShell({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function TextField({
  form,
  name,
  label,
  type = "text",
  placeholder,
}: {
  form: FormApi;
  name: TextName;
  label: string;
  type?: "text" | "email" | "number";
  placeholder?: string;
}) {
  const error = form.formState.errors[name]?.message;
  return (
    <FieldShell id={`email-${name}`} label={label} error={error}>
      <Input
        id={`email-${name}`}
        type={type}
        {...(type === "number" ? { inputMode: "numeric" as const } : {})}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

function SecretField({
  form,
  name,
  label,
  saved,
  type = "text",
  autoComplete = "new-password",
}: {
  form: FormApi;
  name: "smtpUsername" | "smtpPassword" | "imapUsername" | "imapPassword";
  label: string;
  saved: boolean;
  type?: "text" | "password";
  autoComplete?: string;
}) {
  return (
    <FieldShell
      id={`email-${name}`}
      label={label}
      hint={saved ? "Saved. Leave blank to keep it." : "Not saved yet."}
    >
      <Input
        id={`email-${name}`}
        type={type}
        autoComplete={autoComplete}
        placeholder={saved ? "••••••••" : ""}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

function SecurityField({
  form,
  name,
  hint,
}: {
  form: FormApi;
  name: "smtpSecurity" | "imapSecurity";
  hint: string;
}) {
  return (
    <FieldShell id={`email-${name}`} label="Security" hint={hint}>
      <select
        id={`email-${name}`}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        {...form.register(name)}
      >
        <option value="ssl">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </FieldShell>
  );
}

function TestResult({ result }: { result: EmailConnectionTest | undefined }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={`text-xs ${result.ok ? "text-success-soft-foreground" : "text-destructive"}`}
    >
      {result.message}
    </p>
  );
}

const TEST_DONE = ["sent", "failed", "cancelled"];

/** "Test SMTP login", "Test IMAP login" and "Send test email to me" (queued; its status polled). */
function ConnectionTests() {
  const smtp = useMutation({
    mutationFn: backend.connections.email.testSmtp,
    onError: (e) => toast.error(messageFromError(e)),
  });
  const imap = useMutation({
    mutationFn: backend.connections.email.testImap,
    onError: (e) => toast.error(messageFromError(e)),
  });
  const [testId, setTestId] = useState<string | null>(null);
  const sendTest = useMutation({
    mutationFn: backend.connections.email.sendTest,
    onSuccess: (queued) => setTestId(queued.id),
    onError: (e) => toast.error(messageFromError(e)),
  });
  const status = useQuery({
    queryKey: ["email-test-send", testId],
    queryFn: ({ signal }) => backend.connections.email.testStatus(testId!, signal),
    enabled: testId !== null,
    refetchInterval: (q) =>
      q.state.data && TEST_DONE.includes(q.state.data.status) ? false : 3000,
    gcTime: 0,
  });
  const test = status.data;

  return (
    <section aria-labelledby="email-tests" className="space-y-3 border-t pt-4">
      <h3 id="email-tests" className="text-sm font-semibold">
        Check the mailbox
      </h3>
      <p className="text-xs text-muted-foreground">
        The login tests only connect and sign in (15 s at most): nothing is sent, read or changed.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            disabled={smtp.isPending}
            onClick={() => smtp.mutate()}
          >
            {smtp.isPending ? "Testing…" : "Test SMTP login"}
          </Button>
          <TestResult result={smtp.data} />
        </div>
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            disabled={imap.isPending}
            onClick={() => imap.mutate()}
          >
            {imap.isPending ? "Testing…" : "Test IMAP login"}
          </Button>
          <TestResult result={imap.data} />
        </div>
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            disabled={sendTest.isPending}
            onClick={() => sendTest.mutate()}
          >
            Send test email to me
          </Button>
          {test && (
            <p
              role="status"
              className={`text-xs ${test.status === "sent" ? "text-success-soft-foreground" : test.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {test.status === "sent"
                ? `Sent to ${test.to ?? "you"}${test.dryRun ? " (dry run: not really sent)" : ""}. Check the inbox and the spam folder.`
                : test.status === "failed" || test.status === "cancelled"
                  ? `Not sent: ${test.lastError ?? "unknown error"}`
                  : `Queued — the worker sends it shortly.${test.lastError ? ` Waiting: ${test.lastError}` : ""}`}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function DeliverabilityCard() {
  const [selector, setSelector] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const check = useQuery({
    queryKey: ["email-deliverability", asked],
    queryFn: ({ signal }) => backend.connections.email.deliverability(asked ?? "", signal),
    enabled: asked !== null,
    retry: false,
  });

  return (
    <section aria-labelledby="email-deliverability" className="space-y-3 border-t pt-4">
      <div>
        <h3 id="email-deliverability" className="text-sm font-semibold">
          Deliverability check
        </h3>
        <p className="text-xs text-muted-foreground">
          Reads the from domain's DNS (MX, SPF, DKIM, DMARC). It never blocks sending; results are
          cached for 10 minutes.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          // A new selector fetches by its key; the same one again is a Re-check.
          if (asked === selector.trim()) void check.refetch();
          else setAsked(selector.trim());
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="email-dkim-selector" className="text-xs">
            DKIM selector (optional)
          </Label>
          <Input
            id="email-dkim-selector"
            className="w-48"
            value={selector}
            placeholder="e.g. google"
            onChange={(e) => setSelector(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={check.isFetching}>
          {check.isFetching ? "Checking…" : check.data ? "Re-check" : "Check DNS"}
        </Button>
      </form>
      {check.isError && <p className="text-xs text-destructive">{messageFromError(check.error)}</p>}
      {check.data && (
        <ul className="space-y-2" aria-label={`DNS checks for ${check.data.domain}`}>
          {check.data.lines.map((line) => {
            const [tone, text] = CHECK_TONE[line.status];
            return (
              <li key={line.check} className="rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-14 font-medium">{CHECK_LABELS[line.check]}</span>
                  <StatusPill tone={tone} dot>
                    {text}
                  </StatusPill>
                  <span className="min-w-0 break-words">{line.summary}</span>
                </div>
                {line.fix && <p className="mt-1 text-xs text-muted-foreground">{line.fix}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** E3b-2b: "Track email opens" (admin; default off). A soft signal for AI and workflow emails only. */
function OpenTracking({
  data,
  isAdmin,
  onSaved,
}: {
  data: EmailSettings;
  isAdmin: boolean;
  onSaved: (next: EmailSettings) => void;
}) {
  const save = useMutation({
    mutationFn: backend.connections.email.setTrackOpens,
    onSuccess: (next) => {
      onSaved(next);
      toast.success(next.trackOpens ? "Email open tracking is on." : "Email open tracking is off.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  return (
    <section aria-labelledby="email-open-tracking" className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <Label id="email-open-tracking" htmlFor="track-opens" className="text-sm font-semibold">
          Track email opens
        </Label>
        <Switch
          id="track-opens"
          checked={data.trackOpens}
          disabled={!isAdmin || save.isPending || (!data.openTrackingAvailable && !data.trackOpens)}
          onCheckedChange={(checked) => save.mutate(checked)}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Adds a tiny image to AI and workflow emails (never replies, proposals or meeting emails) so
        a first open shows on the contact and raises the hot-lead score. A soft signal only: some
        mail apps load images without the email being read. Update the privacy policy before turning
        this on.
      </p>
      {!data.openTrackingAvailable && (
        <p role="status" className="text-sm text-warning-soft-foreground">
          Open tracking needs a public API address (PUBLIC_API_BASE_URL on the API and worker).
        </p>
      )}
    </section>
  );
}

const when = (at: string | null) => (at ? new Date(at).toLocaleString() : "Never");

/** D3: what the worker read from the mailbox; "Check now" (admin) only schedules the next read. */
function RepliesAndBounces({
  status,
  isAdmin,
  onChecked,
}: {
  status: NonNullable<EmailSettings["imapStatus"]>;
  isAdmin: boolean;
  onChecked: (next: EmailSettings) => void;
}) {
  const checkNow = useMutation({
    mutationFn: backend.connections.email.checkNow,
    onSuccess: (next) => {
      onChecked(next);
      toast.success("The mailbox will be checked within a minute.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const t = status.today;
  return (
    <section aria-labelledby="email-replies" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="email-replies" className="text-sm font-semibold">
          Replies & bounces
        </h3>
        {isAdmin && (
          <Button
            size="sm"
            variant="outline"
            disabled={checkNow.isPending}
            onClick={() => checkNow.mutate()}
          >
            <RefreshCw className="size-3.5" aria-hidden /> Check now
          </Button>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <ReadOnly label="Last check" value={when(status.lastCheckAt)} />
        <ReadOnly label="Last successful check" value={when(status.lastSuccessAt)} />
      </dl>
      {status.lastError && (
        <p role="alert" className="break-words text-sm text-destructive">
          {status.lastError}
        </p>
      )}
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Replies today" value={String(t.replies)} />
        <Stat label="Bounces today" value={String(t.bounces)} />
        <Stat label="Auto-replies today" value={String(t.autoReplies)} />
        <Stat label="Unsubscribes today" value={String(t.unsubscribes)} />
        <Stat label="Unmatched today" value={String(t.unmatched)} />
        <Stat label="Bounces (24 h)" value={String(status.bounces24h)} />
      </dl>
    </section>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

/** Settings → Channels → Email. */
export function EmailSection() {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <>
      <SectionHeader
        title="Email"
        description="The SMTP + IMAP mailbox this workspace sends from."
      />
      {currentWorkspaceId && <EmailPanel workspaceId={currentWorkspaceId} />}
    </>
  );
}
