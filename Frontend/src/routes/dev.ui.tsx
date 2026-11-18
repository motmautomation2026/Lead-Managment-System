import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";

// Dev-only UI kit. In production builds import.meta.env.DEV is false, so the
// showcase import is dropped and the route is a 404.
export const Route = createFileRoute("/dev/ui")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  head: () => ({ meta: [{ title: "UI kit - MOTM Flow" }] }),
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import("@/features/dev/ui-showcase"), "UiShowcase")
    : () => null,
});
