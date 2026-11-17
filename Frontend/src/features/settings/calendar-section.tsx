import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { backend, type GoogleCalendarConnection } from "@/lib/backend-client";
import { backendBaseUrl } from "@/lib/supabase-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { StatusCard } from "@/components/crm/status-card";
import { Switch } from "@/components/ui/switch";
import {
  keys,
  messageFromError,
  useAgentSettings,
  useIsAdmin,
  useUpdateAgentSettings,
} from "@/store";
import { toastUndo } from "@/lib/toast-undo";
import { useWorkspace } from "@/store/workspace-context";

/**
 * Settings → Channels → Google Calendar (UX-1): a status card with Connect / Reconnect, the OAuth client (optional
 * when the platform has one) with a sticky save bar, and Disconnect behind a confirm. Google's OAuth redirect lands
 * here as `?calendar=connected|error` (via /admin, A5): one toast, then the params are stripped.
 */
export function GoogleCalendarPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: keys.connection(workspaceId, "google-calendar"),
    queryFn: ({ signal }) => backend.connections.googleCalendar.get(signal),
    refetchInterval: 5_000,
  });
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const refresh = () =>
    void client.invalidateQueries({ queryKey: keys.connection(workspaceId, "google-calendar") });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const calendarResult = params.get("calendar");
    if (!calendarResult) return;
    if (calendarResult === "connected") toast.success("Google Calendar connected.");
    else toast.error(params.get("message") || "Failed to connect Google Calendar.");
    params.delete("calendar");
    params.delete("message");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    refresh();
    // Only meant to run once, on the redirect landing — not a live dependency loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useMutation({
    mutationFn: backend.connections.googleCalendar.oauthStart,
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const disconnect = useMutation({
    mutationFn: backend.connections.googleCalendar.disconnect,
    onSuccess: () => {
      setDisconnectOpen(false);
      refresh();
      toast.success("Google Calendar disconnected.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const data = query.data;
  if (!data)
    return query.isError ? (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          Couldn't load Google Calendar status: {messageFromError(query.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    ) : (
      <SectionSkeleton label="Loading Google Calendar status" />
    );

  const connectLabel =
    data.status === "connected"
      ? "Reconnect"
      : data.status === "error"
        ? "Reconnect Google Calendar"
        : "Connect Google Calendar";
  const connectButton = (
    <Button
      onClick={() => start.mutate()}
      disabled={!data.configured || start.isPending}
      variant={data.status === "connected" ? "outline" : "default"}
    >
      {connectLabel}
    </Button>
  );
  const credentials = <CredentialsForm data={data} onSaved={refresh} />;

  return (
    <div className="space-y-6">
      <StatusCard
        title="Google Calendar"
        icon={CalendarDays}
        tone={
          data.status === "connected" ? "success" : data.status === "error" ? "danger" : "neutral"
        }
        status={
          data.status === "connected"
            ? "Connected"
            : data.status === "error"
              ? "Needs attention"
              : "Not connected"
        }
        detail={
          data.lastError ??
          (data.status === "connected"
            ? `Meetings sync to ${data.connectedEmail ?? "the connected account"} with a Meet link.`
            : data.configured
              ? "Connect a Google account so meetings get a calendar event and a Meet link."
              : "Add the OAuth client below first.")
        }
        metric={{ label: "Connected account", value: data.connectedEmail || "None" }}
        action={connectButton}
      />

      {data.platformConfigured ? (
        <details className="rounded-lg border px-4 py-3 text-sm" open={data.usesOwnCredentials}>
          <summary className="cursor-pointer font-medium">
            Advanced: use your own Google app
          </summary>
          <div className="mt-3 space-y-4">
            <Notice>
              Most workspaces don't need this — just Connect above. If you save your own OAuth
              client here it replaces the shared one, and you'll need to reconnect.
            </Notice>
            {credentials}
          </div>
        </details>
      ) : (
        <section aria-labelledby="calendar-oauth" className="space-y-4">
          <h3 id="calendar-oauth" className="type-section-title">
            OAuth client
          </h3>
          <Notice>
            Register an OAuth 2.0 client (Web application) in Google Cloud Console with the Calendar
            API enabled, then paste its credentials below. The client secret is encrypted in the
            database.
          </Notice>
          {credentials}
        </section>
      )}

      {data.status === "connected" && (
        <section aria-labelledby="calendar-danger" className="space-y-2 rounded-lg border p-4">
          <h3 id="calendar-danger" className="type-section-title">
            Disconnect
          </h3>
          <p className="type-small text-muted-foreground">
            Meetings stop syncing to Google Calendar until reconnected.
          </p>
          <Button variant="destructive" onClick={() => setDisconnectOpen(true)}>
            Disconnect
          </Button>
        </section>
      )}
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Google Calendar?"
        description="Meetings will no longer sync to Google Calendar or generate Meet links automatically until reconnected. The saved OAuth client credentials are kept, so reconnecting won't require re-entering them."
        confirmLabel="Disconnect"
        disabled={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </div>
  );
}

function CredentialsForm({
  data,
  onSaved,
}: {
  data: GoogleCalendarConnection;
  onSaved: () => void;
}) {
  const suggestedRedirectUri = backendBaseUrl
    ? `${backendBaseUrl}/api/v1/connections/google-calendar/oauth/callback`
    : "";
  const saved = {
    clientId: data.clientId ?? "",
    redirectUri: data.redirectUri ?? suggestedRedirectUri,
  };
  const [clientId, setClientId] = useState(saved.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(saved.redirectUri);
  const dirty =
    clientId !== saved.clientId || redirectUri !== saved.redirectUri || clientSecret !== "";
  // Re-sync from the server while nothing is being edited (the status polls).
  useEffect(() => {
    if (dirty) return;
    setClientId(saved.clientId);
    setRedirectUri(saved.redirectUri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.clientId, saved.redirectUri]);
  const save = useMutation({
    mutationFn: () =>
      backend.connections.googleCalendar.updateCredentials({
        clientId,
        redirectUri,
        ...(clientSecret ? { clientSecret } : {}),
      }),
    onSuccess: () => {
      setClientSecret("");
      onSaved();
      toast.success("Google OAuth credentials saved.");
    },
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Client ID" id="calendar-client-id">
          <Input
            id="calendar-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>
        <Field
          label={`Client secret${data.clientSecretConfigured ? " (configured)" : ""}`}
          id="calendar-client-secret"
        >
          <Input
            id="calendar-client-secret"
            type="password"
            value={clientSecret}
            placeholder={data.clientSecretConfigured ? "•••••••• - retain current" : "GOCSPX-…"}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Redirect URI" id="calendar-redirect-uri">
        <Input
          id="calendar-redirect-uri"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Add this exact URL as an authorized redirect URI on the OAuth client in Google Cloud
          Console.
        </p>
      </Field>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onDiscard={() => {
          save.reset();
          setClientId(saved.clientId);
          setRedirectUri(saved.redirectUri);
          setClientSecret("");
        }}
        error={save.isError ? messageFromError(save.error) : undefined}
        saveLabel="Save credentials"
      />
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Settings → Channels → Google Calendar. */
export function CalendarSection() {
  const { currentWorkspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  return (
    <>
      <SectionHeader
        title="Google Calendar"
        description="A meeting scheduled in the CRM creates an event with a Meet link on this workspace's calendar and invites its participants."
      />
      {currentWorkspaceId && <GoogleCalendarPanel workspaceId={currentWorkspaceId} />}
      {isAdmin && currentWorkspaceId && <MeetingRemindersCard />}
    </>
  );
}

/**
 * UX-3 (moved from AI → Limits & schedule): the LL-2 reminders to the lead, the same `meetingRemindersEnabled`
 * agent setting (admin only). One switch, saved at once with Undo, so it needs no form or SaveBar of its own.
 */
export function MeetingRemindersCard() {
  const settings = useAgentSettings();
  const update = useUpdateAgentSettings();
  const enabled = settings.data?.meetingRemindersEnabled ?? true;
  const save = (value: boolean, undo = true) =>
    update.mutate(
      { meetingRemindersEnabled: value },
      {
        onSuccess: () =>
          undo
            ? toastUndo(`Meeting reminders ${value ? "on" : "off"}`, () => save(!value, false))
            : toast.success(`Meeting reminders ${value ? "on" : "off"}`),
        onError: (error) => toast.error(messageFromError(error)),
      },
    );
  return (
    <section
      className="mt-6 space-y-2 rounded-lg border p-4"
      aria-labelledby="meeting-reminders-title"
    >
      <h3 id="meeting-reminders-title" className="type-section-title">
        Meeting reminders
      </h3>
      {settings.isLoading ? (
        <SectionSkeleton label="Loading meeting reminders" />
      ) : settings.error ? (
        <p className="text-sm text-destructive">{messageFromError(settings.error)}</p>
      ) : (
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            Meeting reminders to the lead
            <span className="block text-xs text-muted-foreground">
              A short fixed reminder (not AI) 24 hours and 1 hour before a scheduled meeting, by
              email and WhatsApp. The rep's own 1-hour reminder always goes.
            </span>
          </span>
          <Switch
            id="meeting-reminders"
            checked={enabled}
            disabled={update.isPending}
            onCheckedChange={(value) => save(value)}
          />
        </label>
      )}
    </section>
  );
}
