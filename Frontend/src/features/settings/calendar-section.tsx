import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { backend } from "@/lib/backend-client";
import { backendBaseUrl } from "@/lib/supabase-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { keys, messageFromError } from "@/store";
import { SectionHeader } from "@/components/crm/section-layout";
import { useWorkspace } from "@/store/workspace-context";

export function GoogleCalendarPanel({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: keys.connection(workspaceId, "google-calendar"),
    queryFn: ({ signal }) => backend.connections.googleCalendar.get(signal),
    refetchInterval: 5_000,
  });
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const refresh = () =>
    void client.invalidateQueries({ queryKey: keys.connection(workspaceId, "google-calendar") });

  const suggestedRedirectUri = backendBaseUrl
    ? `${backendBaseUrl}/api/v1/connections/google-calendar/oauth/callback`
    : "";
  useEffect(() => {
    if (query.data && !dirty) {
      setClientId(query.data.clientId ?? "");
      setRedirectUri(query.data.redirectUri ?? suggestedRedirectUri);
    }
    // Only re-sync from freshly-fetched server data, not on every keystroke
    // recomputing suggestedRedirectUri.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, dirty]);

  // Google's OAuth redirect lands back here as ?calendar=connected|error —
  // surface it once as a toast, then strip it so a page refresh doesn't
  // re-show it.
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

  const saveCredentials = useMutation({
    mutationFn: () =>
      backend.connections.googleCalendar.updateCredentials({
        clientId,
        redirectUri,
        ...(clientSecret ? { clientSecret } : {}),
      }),
    onSuccess: () => {
      setDirty(false);
      setClientSecret("");
      refresh();
      toast.success("Google OAuth credentials saved.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
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

  const credentialsForm = data && (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Client ID">
          <Input
            value={clientId}
            onChange={(e) => {
              setDirty(true);
              setClientId(e.target.value);
            }}
          />
        </Field>
        <Field label={`Client secret${data.clientSecretConfigured ? " (configured)" : ""}`}>
          <Input
            type="password"
            value={clientSecret}
            placeholder={data.clientSecretConfigured ? "•••••••• - retain current" : "GOCSPX-…"}
            onChange={(e) => {
              setDirty(true);
              setClientSecret(e.target.value);
            }}
          />
        </Field>
      </div>
      <Field label="Redirect URI">
        <Input
          value={redirectUri}
          onChange={(e) => {
            setDirty(true);
            setRedirectUri(e.target.value);
          }}
        />
      </Field>
      <p className="-mt-3 text-xs text-muted-foreground">
        Add this exact URL as an authorized redirect URI on the OAuth client in Google Cloud
        Console.
      </p>
      <div className="flex justify-end border-b pb-4">
        <Button onClick={() => saveCredentials.mutate()} disabled={saveCredentials.isPending}>
          Save credentials
        </Button>
      </div>
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays /> Google Calendar
        </CardTitle>
        <CardDescription>
          A meeting scheduled in the CRM creates an event with an auto-generated Meet link on this
          workspace's calendar and invites its participants.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!data ? (
          query.isError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                Couldn't load Google Calendar status: {messageFromError(query.error)}
              </p>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading Google Calendar status…</p>
          )
        ) : (
          <>
            {data.platformConfigured ? (
              <details
                className="rounded-md border px-3 py-2 text-sm"
                open={data.usesOwnCredentials}
              >
                <summary className="cursor-pointer text-muted-foreground">
                  Advanced: use your own Google app
                </summary>
                <div className="mt-3 space-y-4">
                  <Notice>
                    Most workspaces don't need this — just click Connect below. If you save your own
                    OAuth client here it replaces the shared one, and you'll need to reconnect.
                  </Notice>
                  {credentialsForm}
                </div>
              </details>
            ) : (
              <>
                <Notice>
                  Register an OAuth 2.0 client (Web application) in Google Cloud Console with the
                  Calendar API enabled, then paste its credentials below. The client secret is
                  encrypted in the database, same as the Resend API key.
                </Notice>
                {credentialsForm}
              </>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Metric label="Status" value={data.status.replaceAll("_", " ")} />
              <Metric label="Connected account" value={data.connectedEmail || "Not connected"} />
            </div>
            {data.lastError && <Notice danger>{data.lastError}</Notice>}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button onClick={() => start.mutate()} disabled={!data.configured || start.isPending}>
                {data.status === "connected"
                  ? "Reconnect"
                  : data.status === "error"
                    ? "Reconnect Google Calendar"
                    : "Connect Google Calendar"}
              </Button>
              {data.status === "connected" && (
                <Button
                  variant="destructive"
                  className="ml-auto"
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Google Calendar?"
        description="Meetings will no longer sync to Google Calendar or generate Meet links automatically until reconnected. The saved OAuth client credentials are kept, so reconnecting won't require re-entering them."
        confirmLabel="Disconnect"
        disabled={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs">{label}</Label>
      {children}
    </div>
  );
}
function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${danger ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/50 text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold capitalize">{value}</div>
    </div>
  );
}

/** Settings → Channels → Google Calendar. */
export function CalendarSection() {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <>
      <SectionHeader
        title="Google Calendar"
        description="Meet links and invites for CRM meetings."
      />
      {currentWorkspaceId && <GoogleCalendarPanel workspaceId={currentWorkspaceId} />}
    </>
  );
}
