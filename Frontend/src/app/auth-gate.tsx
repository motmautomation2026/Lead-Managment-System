import { useEffect, type ReactNode } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { Navigate, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/app/app-shell";
import { StoreProvider } from "@/store";
import { keys } from "@/store/query";
import { configurationError } from "@/lib/supabase-client";
import { useSupabaseSession } from "@/lib/use-supabase-session";
import { LoginPage } from "@/features/auth/login-page";
import { backend, BackendError } from "@/lib/backend-client";
import { BrandLogo } from "@/components/common/brand-logo";

/** Routes served without authentication — must also render without a session or backend. */
const PUBLIC_PATHS = ["/privacy"];

/** Gates the application behind required Supabase authentication. */
export function AuthGate({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  const { loading, session } = useSupabaseSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const me = useQuery({
    queryKey: keys.authRole(session?.user.id),
    queryFn: ({ signal }) => backend.me(signal),
    enabled: Boolean(session),
    staleTime: 60_000,
  });
  // Also while a navigation away from /admin is pending, so its redirect never renders for a
  // salesperson being sent to "/".
  const adminPath = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith("/admin") ||
      state.matches.some((match) => match.pathname.startsWith("/admin")),
  });

  useEffect(() => {
    if (!loading && !session) queryClient.clear();
  }, [loading, session, queryClient]);

  // Public pages that must load for signed-out visitors (and Google's OAuth
  // reviewers): skip the login gate and the app shell entirely.
  if (PUBLIC_PATHS.includes(pathname.replace(/\/+$/, ""))) return <>{children}</>;

  if (configurationError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-lg rounded-lg border bg-card p-6 text-center shadow-sm">
          <BrandLogo variant="mark" className="mx-auto mb-5 size-14" />
          <h1 className="text-lg font-semibold">MOTM Flow is not configured</h1>
          <p className="mt-2 text-sm text-muted-foreground">{configurationError}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Add the browser-safe values documented in Frontend/.env.example and restart the
            frontend.
          </p>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-sm text-muted-foreground"
        role="status"
      >
        <BrandLogo variant="mark" className="size-14" />
        <span>Loading…</span>
      </div>
    );
  }
  if (!session) return <LoginPage adminMode={adminPath} />;
  if (me.isLoading) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 text-sm text-muted-foreground"
        role="status"
      >
        <BrandLogo variant="mark" className="size-14" />
        <span>Checking access…</span>
      </div>
    );
  }
  // An expired/invalid session (backend-client.ts already signs out locally
  // on any 401) is a login-required state, not an app crash — show the login
  // page instead of throwing to the router's generic error boundary. Any
  // other failure (network, 500s) still throws so it's visibly surfaced.
  if (me.isError && me.error instanceof BackendError && me.error.status === 401) {
    return <LoginPage adminMode={adminPath} />;
  }
  if (me.isError || !me.data) throw me.error;
  // /admin redirects into Settings (routes/admin.tsx). The Google Calendar OAuth landing
  // (A5: always /admin?calendar=…) goes there for every role; other /admin visits are admins-only.
  if (adminPath && me.data.role !== "admin" && !window.location.search.includes("calendar=")) {
    return <Navigate to="/" replace />;
  }
  return (
    <StoreProvider>
      <AppShell>{children}</AppShell>
    </StoreProvider>
  );
}
