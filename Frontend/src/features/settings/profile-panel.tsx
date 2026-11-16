import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Mail } from "lucide-react";
import { toast } from "sonner";
import { backend } from "@/lib/backend-client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { keys, messageFromError } from "@/store";
import { SaveBar } from "@/components/crm/save-bar";
import { bookingUrlField } from "./booking-url";
import { SectionHeader } from "@/components/crm/section-layout";

const schema = z.object({ bookingUrl: bookingUrlField });
type FormValues = z.infer<typeof schema>;

/**
 * Settings → Profile (E3b-1 rule 5): every user's own booking link. When the AI asks one of
 * their contacts for a call, it adds "you can pick a time here: <link>" (never in a first WhatsApp).
 */
export function ProfilePanel() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: keys.session, queryFn: ({ signal }) => backend.me(signal) });
  const save = useMutation({
    mutationFn: backend.updateMe,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.session });
      toast.success("Booking link saved.");
    },
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { bookingUrl: "" },
  });
  const { reset } = form;
  const saved = me.data?.bookingUrl ?? "";
  useEffect(() => reset({ bookingUrl: saved }), [saved, reset]);
  const error = form.formState.errors.bookingUrl;
  const submit = form.handleSubmit((values) =>
    save.mutate({ bookingUrl: values.bookingUrl.trim() || null }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock /> Profile
        </CardTitle>
        <CardDescription>
          {me.data ? `${me.data.name} · ${me.data.email}` : "Your account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {me.isError ? (
          <p className="text-sm text-destructive">{messageFromError(me.error)}</p>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
            <div className="space-y-1">
              <Label htmlFor="profile-booking-url">Booking link</Label>
              <Input
                id="profile-booking-url"
                type="url"
                inputMode="url"
                placeholder="https://calendly.com/your-name"
                aria-invalid={Boolean(error)}
                disabled={me.isLoading}
                {...form.register("bookingUrl")}
              />
              <p className="text-xs text-muted-foreground">
                When the AI asks your contacts for a call, it adds this link so they can pick a
                time. Leave empty for none.
              </p>
              {error && <p className="text-xs text-destructive">{error.message}</p>}
            </div>
            <SaveBar
              dirty={form.formState.isDirty}
              saving={save.isPending}
              disabled={me.isLoading}
              onSave={() => void submit()}
              onDiscard={() => {
                save.reset();
                reset({ bookingUrl: saved });
              }}
              error={save.isError ? messageFromError(save.error) : undefined}
              saveLabel="Save booking link"
            />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * LL-2 rule 3: staff emails from the workspace mailbox to the login email. Each switch saves at once.
 * "Email me urgent alerts": new website lead, a reply, an escalation, a meeting in 1 hour, AI stopped / handed off.
 */
export function EmailAlertsPanel() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: keys.session, queryFn: ({ signal }) => backend.me(signal) });
  const save = useMutation({
    mutationFn: backend.updateMe,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.session });
      toast.success("Email settings saved.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const rows: {
    field: "emailAlertsEnabled" | "emailDigestEnabled";
    label: string;
    help: string;
  }[] = [
    {
      field: "emailAlertsEnabled",
      label: "Email me urgent alerts",
      help: "New website lead, a lead replied, a task escalated, a meeting in 1 hour, AI stopped or handed off. Several at once come in one email.",
    },
    {
      field: "emailDigestEnabled",
      label: "Morning digest",
      help: "09:00 IST, Monday–Saturday: calls due, replies waiting, meetings today and overdue tasks. Not sent when there is nothing open.",
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail /> Email alerts
        </CardTitle>
        <CardDescription>
          Sent to {me.data?.email ?? "your login email"} so you don't miss anything when the CRM is
          closed. They also stay in the bell.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {me.isError ? (
          <p className="text-sm text-destructive">{messageFromError(me.error)}</p>
        ) : (
          rows.map((row) => (
            <div key={row.field} className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor={`profile-${row.field}`}>{row.label}</Label>
                <p className="text-xs text-muted-foreground">{row.help}</p>
              </div>
              <Switch
                id={`profile-${row.field}`}
                checked={me.data?.[row.field] ?? true}
                disabled={me.isLoading || save.isPending}
                onCheckedChange={(on) => save.mutate({ [row.field]: on })}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Personal → My profile. */
export function ProfileSection() {
  return (
    <>
      <SectionHeader
        title="My profile"
        description="Your account, booking link and email alerts."
      />
      <div className="space-y-6">
        <ProfilePanel />
        <EmailAlertsPanel />
      </div>
    </>
  );
}
