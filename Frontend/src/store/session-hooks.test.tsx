import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workspaceRole: "salesperson" }));

vi.mock("./workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspaceId: "ws-1",
    currentWorkspace: { id: "ws-1", role: mocks.workspaceRole },
  }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    // The GLOBAL role is admin; the role in ws-1 decides.
    me: async () => ({
      id: "u-1",
      name: "Asha",
      email: "a@x.in",
      role: "admin",
      isSuperAdmin: false,
    }),
    profiles: async () => ({
      data: [
        {
          id: "u-1",
          name: "Asha",
          email: "a@x.in",
          initials: "A",
          active: true,
          role: "salesperson",
          member: true,
        },
        {
          id: "u-9",
          name: "Old Rep",
          email: "o@x.in",
          initials: "OR",
          active: true,
          role: "salesperson",
          member: false,
        },
      ],
    }),
  },
}));

import { useSession } from "./server-hooks";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe("useSession (E4b)", () => {
  it("the role is the one in the current workspace; non-members are labelled and not pickable", async () => {
    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    expect(result.current.currentUser?.role).toBe("Salesperson");
    expect(result.current.canManageUsers).toBe(true);
    expect(result.current.userName("u-9")).toBe("Old Rep (not in this workspace)");
    expect(result.current.users.filter((u) => u.active).map((u) => u.id)).toEqual(["u-1"]);
  });
});
