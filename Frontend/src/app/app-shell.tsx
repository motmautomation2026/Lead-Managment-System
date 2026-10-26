import { lazy, Suspense, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import {
  AddLeadContext,
  CreateCompanyContext,
  CreateDealContext,
  CreateTaskContext,
  ScheduleMeetingContext,
  type CreateDealOptions,
  type CreateTaskOptions,
  type ScheduleMeetingOptions,
} from "@/app/add-lead-context";
import { AppSidebar } from "@/app/sidebar";
import { TopBar } from "@/app/top-bar";
import { ShortcutsDialog } from "@/app/shortcuts-dialog";
import { focusListSearch, useShortcuts } from "@/app/shortcuts";
import { messageFromError } from "@/store";
import { backend } from "@/lib/backend-client";
import { keys } from "@/store/query";
import { useWorkspace } from "@/store/workspace-context";
import { SIDEBAR_KEY, readPreference, writePreference } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export { PageHeader } from "@/components/crm/page-header";

// Loaded on first open, so their libraries (cmdk, react-hook-form, libphonenumber, Radix
// Select) stay out of the first load (C5).
const CommandPalette = lazy(() =>
  import("@/app/command-palette").then((m) => ({ default: m.CommandPalette })),
);
const CreateContactDialog = lazy(() =>
  import("@/features/contacts/create-contact-dialog").then((m) => ({
    default: m.CreateContactDialog,
  })),
);
const CreateCompanyDialog = lazy(() =>
  import("@/features/companies/create-company-dialog").then((m) => ({
    default: m.CreateCompanyDialog,
  })),
);
const CreateDealDialog = lazy(() =>
  import("@/features/deals/create-deal-dialog").then((m) => ({ default: m.CreateDealDialog })),
);
const CreateTaskDialog = lazy(() =>
  import("@/features/work/create-task-dialog").then((m) => ({ default: m.CreateTaskDialog })),
);
const ScheduleMeetingFlow = lazy(() =>
  import("@/features/work/schedule-meeting-flow").then((m) => ({
    default: m.ScheduleMeetingFlow,
  })),
);

/** True from the first time `open` is true (keeps a lazy dialog mounted for its close animation). */
function useOpenedOnce(open: boolean) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return open || opened;
}

/** Signed-in layout: sidebar (docked lg+, Sheet below), top bar, page content. */
export function AppShell({ children }: { children: ReactNode }) {
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => readPreference(SIDEBAR_KEY, ["true", "false"], "false") === "true",
  );
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [addCompany, setAddCompany] = useState("");
  // `n` remounts the dialog per opening so its form starts from that opening's options.
  const [deal, setDeal] = useState<{ open: boolean; n: number; options: CreateDealOptions }>({
    open: false,
    n: 0,
    options: {},
  });
  const openDeal = (options: CreateDealOptions = {}) =>
    setDeal((d) => ({ open: true, n: d.n + 1, options }));
  const [task, setTask] = useState<{ open: boolean; n: number; options: CreateTaskOptions }>({
    open: false,
    n: 0,
    options: {},
  });
  const openTask = (options: CreateTaskOptions = {}) =>
    setTask((t) => ({ open: true, n: t.n + 1, options }));
  const [meeting, setMeeting] = useState<{
    open: boolean;
    n: number;
    options: ScheduleMeetingOptions;
  }>({ open: false, n: 0, options: {} });
  const openMeeting = (options: ScheduleMeetingOptions = {}) =>
    setMeeting((m) => ({ open: true, n: m.n + 1, options }));
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const paletteMounted = useOpenedOnce(paletteOpen);
  const contactMounted = useOpenedOnce(addOpen);
  const companyMounted = useOpenedOnce(companyOpen);
  const dealMounted = useOpenedOnce(deal.open);
  const taskMounted = useOpenedOnce(task.open);
  const meetingMounted = useOpenedOnce(meeting.open);
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

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigate = useNavigate();
  useShortcuts({
    palette: () => setPaletteOpen((o) => !o),
    help: () => setShortcutsOpen(true),
    search: focusListSearch,
    create: () => setCreateMenuOpen(true),
    goContacts: () => void navigate({ to: "/contacts" }),
    goCompanies: () => void navigate({ to: "/companies" }),
    goDeals: () => void navigate({ to: "/deals" }),
    goTasks: () => void navigate({ to: "/tasks" }),
    goMeetings: () => void navigate({ to: "/meetings" }),
    goProposals: () => void navigate({ to: "/proposals" }),
  });

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePreference(SIDEBAR_KEY, String(!c));
      return !c;
    });
  };

  return (
    <AddLeadContext.Provider
      value={{
        open: (prefill) => {
          setAddCompany(prefill?.company ?? "");
          setAddOpen(true);
        },
      }}
    >
      <CreateCompanyContext.Provider value={{ open: () => setCompanyOpen(true) }}>
        <CreateDealContext.Provider value={{ open: openDeal }}>
          <CreateTaskContext.Provider value={{ open: openTask }}>
            <ScheduleMeetingContext.Provider value={{ open: openMeeting }}>
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
                      onCreateCompany={() => setCompanyOpen(true)}
                      onCreateDeal={() => openDeal()}
                      onCreateTask={() => openTask()}
                      onCreateMeeting={() => openMeeting()}
                      createMenuOpen={createMenuOpen}
                      onCreateMenuOpenChange={setCreateMenuOpen}
                      onOpenShortcuts={() => setShortcutsOpen(true)}
                    />
                    <main className="min-w-0 flex-1">{children}</main>
                  </div>
                </div>
              </TooltipProvider>

              <Suspense fallback={null}>
                {contactMounted && (
                  <CreateContactDialog
                    open={addOpen}
                    onOpenChange={(open) => {
                      setAddOpen(open);
                      if (!open) setAddCompany("");
                    }}
                    defaultCompany={addCompany}
                  />
                )}
                {companyMounted && (
                  <CreateCompanyDialog open={companyOpen} onOpenChange={setCompanyOpen} />
                )}
                {dealMounted && (
                  <CreateDealDialog
                    key={deal.n}
                    open={deal.open}
                    onOpenChange={(open) => setDeal((d) => ({ ...d, open }))}
                    options={deal.options}
                  />
                )}
                {taskMounted && (
                  <CreateTaskDialog
                    key={`task-${task.n}`}
                    open={task.open}
                    onOpenChange={(open) => setTask((t) => ({ ...t, open }))}
                    options={task.options}
                  />
                )}
                {meetingMounted && (
                  <ScheduleMeetingFlow
                    key={`meeting-${meeting.n}`}
                    leadId={meeting.options.leadId}
                    dealId={meeting.options.dealId}
                    open={meeting.open}
                    onOpenChange={(open) => setMeeting((m) => ({ ...m, open }))}
                  />
                )}
              </Suspense>

              <Dialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen}>
                <DialogContent className="sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle>Create workspace</DialogTitle>
                    <DialogDescription>
                      Gives this brand or entity its own leads, workflows, templates, and
                      Email/WhatsApp/ Calendar connections.
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

              <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

              <Suspense fallback={null}>
                {paletteMounted && (
                  <CommandPalette
                    open={paletteOpen}
                    onOpenChange={setPaletteOpen}
                    onCreateContact={() => setAddOpen(true)}
                    onCreateCompany={() => setCompanyOpen(true)}
                    onCreateDeal={() => openDeal()}
                    onCreateTask={() => openTask()}
                    onScheduleMeeting={() => openMeeting()}
                  />
                )}
              </Suspense>
            </ScheduleMeetingContext.Provider>
          </CreateTaskContext.Provider>
        </CreateDealContext.Provider>
      </CreateCompanyContext.Provider>
    </AddLeadContext.Provider>
  );
}
