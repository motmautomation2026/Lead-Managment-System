import { useState, type ReactNode } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  backend,
  type DeliverabilityCheck,
  type EmailConnectionTest,
  type EmailSettings,
  type EmailSettingsInput,
} from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { keys, messageFromError, useIsAdmin } from "@/store";

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
 * Settings → Workspace → Email (E1b): the SMTP + IMAP mailbox, connection tests, a test
 * email, safety limits, pause/resume, monitoring and the deliverability check. Every CRM
 * user can read it (never a secret); only admins change, test or resume.
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
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {query.isError ? (
            <div className="space-y-2">
              <p className="text-destructive">
                Couldn't load the email settings: {messageFromError(query.error)}
              </p>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          ) : (
            "Loading email settings…"
          )}
        </CardContent>
      </Card>
    );

  const capText =
    data.warmupDay !== null && data.effectiveDailyCap < data.dailyCap
      ? `${data.sentToday} / ${data.effectiveDailyCap} (warm-up day ${data.warmupDay})`
      : `${data.sentToday} / ${data.effectiveDailyCap}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail /> Email
        </CardTitle>
        <CardDescription>
          Email goes out through your own mailbox (SMTP), one at a time from the background worker.
          Passwords are encrypted and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data.configured && (
          <div
            role="status"
            className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
          >
            <div className="font-medium">Email is not set up</div>
            <div>
              {data.legacyProvider === "resend"
                ? "This workspace used Resend, which is no longer supported. "
                : ""}
              {isAdmin
                ? "Add the SMTP mailbox below. Emails wait in the queue until then."
                : "An admin must add the SMTP mailbox here. Emails wait in the queue until then."}
            </div>
          </div>
        )}

        {data.pause && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <div className="font-medium">Email sending is paused</div>
                <div>{data.pause.reason ?? "Sending is turned off."}</div>
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

        {isAdmin ? (
          <>
            <EmailForm key={workspaceId} data={data} onSaved={store} />
            {data.configured && <ConnectionTests />}
          </>
        ) : (
          <ReadOnlySettings data={data} />
        )}

        <section aria-labelledby="email-monitoring" className="space-y-3 border-t pt-4">
          <h3 id="email-monitoring" className="text-sm font-semibold">
            Sending
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sent today" value={capText} />
            <Stat label="Sent this hour" value={`${data.sentThisHour} / ${data.hourlyCap}`} />
            <Stat label="Send failures (24 h)" value={String(data.failures24h)} />
            <Stat label="Rejected by recipient (24 h)" value={String(data.rejections24h)} />
          </div>
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
                <th className="py-1 text-right font-normal">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((day) => (
                <tr key={day.date} className="border-t">
                  <td className="py-1">{day.date}</td>
                  <td className="py-1 text-right tabular-nums">{day.sent}</td>
                  <td className="py-1 text-right tabular-nums">{day.failed}</td>
                  <td className="py-1 text-right tabular-nums">{day.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {isAdmin && data.configured && <DeliverabilityCard />}

        <ConfirmDialog
          open={resumeOpen}
          onOpenChange={setResumeOpen}
          title="Resume email sending?"
          description="Queued emails will start going out again, with the usual spacing, caps and send window. Check why it was paused first."
          confirmLabel="Resume sending"
          disabled={resume.isPending}
          onConfirm={() => resume.mutate()}
        />
      </CardContent>
    </Card>
  );
}

function ReadOnlySettings({ data }: { data: EmailSettings }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {data.configured && (
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
      )}
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

function EmailForm({
  data,
  onSaved,
}: {
  data: EmailSettings;
  onSaved: (next: EmailSettings) => void;
}) {
  const form = useForm<EmailFormValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: formValues(data),
  });
  const errors = form.formState.errors;
  const sameLogin = form.watch("imapSameLogin");
  const save = form.handleSubmit(async (values) => {
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
      toast.error(messageFromError(error));
    }
  });

  return (
    <form className="space-y-5" onSubmit={(e) => void save(e)} noValidate>
      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">Sending (SMTP)</legend>
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
          from name.
        </p>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">Replies and bounces (IMAP)</legend>
        <p className="text-xs text-muted-foreground">
          Replies and bounces will be read from this mailbox in the next update.
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

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-semibold">Safety</legend>
        <p className="text-xs text-muted-foreground">
          Slow, capped sending protects the mailbox's reputation. Workflow emails go out only inside
          the send window; a rep's proposal, meeting and test emails are not held by it.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            form={form}
            name="minDelaySeconds"
            label="Min spacing (seconds)"
            type="number"
          />
          <TextField
            form={form}
            name="maxDelaySeconds"
            label="Max spacing (seconds)"
            type="number"
          />
          <TextField form={form} name="dailyCap" label="Daily cap (IST)" type="number" />
          <TextField form={form} name="hourlyCap" label="Hourly cap" type="number" />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Send window for workflow emails (IST)</legend>
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
                aria-label="Sending enabled"
              />
              Sending enabled
            </label>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save email settings
        </Button>
      </div>
    </form>
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
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
