import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AddLeadContext } from "@/app/add-lead-context";
import { CommandPalette } from "@/app/command-palette";
import { AppSidebar } from "@/app/sidebar";
import { TopBar } from "@/app/top-bar";
import { AddLeadDialog } from "@/features/leads/add-lead-dialog";
import { messageFromError } from "@/store";
import { backend } from "@/lib/backend-client";
import { keys } from "@/store/query";
import { useWorkspace } from "@/store/workspace-context";
import { SIDEBAR_KEY, readPreference, writePreference } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export { PageHeader } from "@/components/crm/page-header";

/** Signed-in layout: sidebar (docked lg+, Sheet below), top bar, page content. */
export function AppShell({ children }: { children: ReactNode }) {
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => readPreference(SIDEBAR_KEY, ["true", "false"], "false") === "true",
  );
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const client = useQueryClient();
  const { setCurrentWorkspaceId } = useWorkspace();

  const createWorkspace = useMutation({
    mutationFn: (name: string) => backend.workspaces.create(name),
    onSuccess: (workspace) => {
      void client.invalidateQueries({ queryKey: keys.workspaces });
      setCurrentWorkspaceId(workspace.id);
      setNewWorkspaceName("");
      setCreateWorkspaceOpen(false);
      toast.success(`Workspace "${workspace.name}" created.`);
    },
    onError: (error: unknown) => toast.error(messageFromError(error)),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePreference(SIDEBAR_KEY, String(!c));
      return !c;
    });
  };

  return (
    <AddLeadContext.Provider value={{ open: () => setAddOpen(true) }}>
      <TooltipProvider delayDuration={300}>
        <div className="flex min-h-screen bg-background">
          <aside
            className={cn(
              "sticky top-0 hidden h-screen shrink-0 border-r border-sidebar-border transition-[width] lg:block",
              collapsed ? "w-14" : "w-60",
            )}
          >
            <AppSidebar
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
            />
          </aside>

          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <AppSidebar
                onNavigate={() => setMobileNavOpen(false)}
                onCreateWorkspace={() => {
                  setMobileNavOpen(false);
                  setCreateWorkspaceOpen(true);
                }}
              />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar
              onOpenMenu={() => setMobileNavOpen(true)}
              onOpenSearch={() => setPaletteOpen(true)}
              onCreateContact={() => setAddOpen(true)}
            />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
      </TooltipProvider>

      <AddLeadDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>
              Gives this brand or entity its own leads, workflows, templates, and Email/WhatsApp/
              Calendar connections.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="mb-1.5 block text-xs">Name</Label>
            <Input
              autoFocus
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="e.g. Northbeam Labs"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateWorkspaceOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newWorkspaceName.trim() || createWorkspace.isPending}
              onClick={() => createWorkspace.mutate(newWorkspaceName.trim())}
            >
              {createWorkspace.isPending ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onCreateContact={() => setAddOpen(true)}
      />
    </AddLeadContext.Provider>
  );
}
