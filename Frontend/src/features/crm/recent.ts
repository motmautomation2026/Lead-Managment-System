import { useEffect } from "react";
import { rememberRecent, type RecentType } from "@/lib/recent-records";
import { useWorkspace } from "@/store/workspace-context";

/** Records an opened record for the palette's "Recent" list once it has loaded. */
export function useRememberRecent(type: RecentType, id: string | undefined, label: string) {
  const { currentWorkspaceId } = useWorkspace();
  useEffect(() => {
    if (id) rememberRecent(currentWorkspaceId, { type, id, label });
  }, [currentWorkspaceId, type, id, label]);
}
