import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { PageHeader } from "./page-header";
import { SectionHeader, SectionLayout } from "./section-layout";
import { StatusCard } from "./status-card";
import { SectionTabs } from "./section-tabs";
import { DetailDrawer } from "./detail-drawer";
import { SaveBar } from "./save-bar";
import { SectionSkeleton } from "./section-skeleton";
import { EmptyState } from "./empty-state";
import { ConfirmDialog } from "@/components/common/confirm-dialog";

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { toastUndo } from "@/lib/toast-undo";

afterEach(cleanup);

/** Renders `ui` at /contacts inside a router that also has /deals ("Page B"). */
async function inRouter(ui: () => ReactNode, path = "/contacts") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/contacts", component: ui }),
      createRoute({ getParentRoute: () => root, path: "/deals", component: () => <h1>Page B</h1> }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

describe("PageHeader", () => {
  it("shows title, count, primary action, the More menu and a filters row", () => {
    const onExport = vi.fn();
    render(
      <PageHeader
        title="Contacts"
        count={1234}
        primaryAction={<button>Create contact</button>}
        menuActions={[{ label: "Export", onSelect: onExport }]}
        filters={<div>filters row</div>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Contacts" })).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("filters row")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(onExport).toHaveBeenCalled();
  });

  it("has no More button without menu actions", () => {
    render(<PageHeader title="Tasks" />);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

describe("SectionLayout", () => {
  const groups = [
    {
      label: "Channels",
      items: [
        { id: "a", label: "Section A", to: "/contacts" as const },
        { id: "b", label: "Section B", to: "/deals" as const },
      ],
    },
  ];
  it("marks the open section, links the others and has a phone back link", async () => {
    const router = await inRouter(() => (
      <SectionLayout
        navLabel="Sections"
        groups={groups}
        activeId="a"
        showListOnPhone={false}
        backTo="/deals"
        backLabel="All sections"
      >
        <SectionHeader title="Section A" description="About A" />
      </SectionLayout>
    ));
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(nav).toHaveClass("hidden");
    expect(screen.getByRole("link", { name: "Section A" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "All sections" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Section B" }));
    await screen.findByRole("heading", { name: "Page B" });
    expect(router.state.location.pathname).toBe("/deals");
  });

  it("on the list page shows the nav and hides the content on phones", async () => {
    await inRouter(() => (
      <SectionLayout
        navLabel="Sections"
        groups={groups}
        activeId={null}
        showListOnPhone
        backTo="/contacts"
        backLabel="All sections"
      >
        <p>content</p>
      </SectionLayout>
    ));
    expect(await screen.findByRole("navigation", { name: "Sections" })).not.toHaveClass("hidden");
    expect(screen.getByText("content").parentElement).toHaveClass("hidden");
  });
});

describe("StatusCard", () => {
  it("shows status, the key number and the next action", () => {
    render(
      <StatusCard
        title="Email"
        icon={Mail}
        tone="danger"
        status="Paused"
        detail="Too many failures"
        metric={{ label: "Sent today", value: "12 / 40" }}
        action={<button>Resume sending</button>}
      />,
    );
    const card = screen.getByRole("region", { name: "Email status" });
    expect(card).toHaveTextContent("Paused");
    expect(card).toHaveTextContent("Too many failures");
    expect(card).toHaveTextContent("12 / 40");
    expect(screen.getByRole("button", { name: "Resume sending" })).toBeInTheDocument();
  });
});

describe("SectionTabs", () => {
  function Tabs() {
    const [tab, setTab] = useState("one");
    return (
      <SectionTabs
        label="Email"
        value={tab}
        onValueChange={setTab}
        keepMounted={["one"]}
        tabs={[
          { id: "one", label: "One", content: <input aria-label="kept" /> },
          { id: "two", label: "Two", content: <p>second</p>, badge: <span>3</span> },
        ]}
      />
    );
  }
  it("switches tabs and keeps keepMounted tabs in the DOM", () => {
    render(<Tabs />);
    fireEvent.change(screen.getByLabelText("kept"), { target: { value: "draft" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Two/ }), { button: 0 });
    expect(screen.getByText("second")).toBeVisible();
    expect(screen.getByLabelText("kept")).toHaveValue("draft");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "One" }), { button: 0 });
    expect(screen.queryByText("second")).toBeNull();
  });
  it("falls back to the first tab for an unknown value", () => {
    render(
      <SectionTabs
        label="X"
        value="nope"
        onValueChange={vi.fn()}
        tabs={[{ id: "one", label: "One", content: <p>first</p> }]}
      />,
    );
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("DetailDrawer", () => {
  it("shows the title, body and footer and closes", () => {
    const onOpenChange = vi.fn();
    render(
      <DetailDrawer
        open
        onOpenChange={onOpenChange}
        title="Number 1"
        footer={<button>Save</button>}
      >
        <p>body</p>
      </DetailDrawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Number 1" });
    expect(dialog).toHaveTextContent("body");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("SaveBar", () => {
  it("shows only while dirty, saves, discards and shows a server error", async () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = await (async () => {
      let setDirty: (v: boolean) => void = () => undefined;
      function Bar() {
        const [dirty, set] = useState(false);
        setDirty = set;
        return <SaveBar dirty={dirty} onSave={onSave} onDiscard={onDiscard} error="Bad port" />;
      }
      await inRouter(Bar);
      return { rerender: (v: boolean) => setDirty(v) };
    })();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    rerender(true);
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    expect(bar).toHaveTextContent("Bad port");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onSave).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });

  it("asks before leaving the page with unsaved changes", async () => {
    const router = await inRouter(() => (
      <>
        <SaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />
        <Link to="/deals">Go to B</Link>
      </>
    ));
    fireEvent.click(await screen.findByRole("link", { name: "Go to B" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/contacts");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("link", { name: "Go to B" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await screen.findByRole("heading", { name: "Page B" });
  });
});

describe("ConfirmDialog", () => {
  it("says what happens and confirms or cancels", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Pause sending?"
        description={<strong>Queued messages wait.</strong>}
        confirmLabel="Pause"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("Queued messages wait.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("EmptyState and SectionSkeleton", () => {
  it("empty state offers one next action", () => {
    render(<EmptyState title="No numbers" text="Add one." action={<button>Add number</button>} />);
    expect(screen.getByText("No numbers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add number" })).toBeInTheDocument();
  });
  it("skeleton is announced as loading", () => {
    render(<SectionSkeleton label="Loading email settings" />);
    expect(screen.getByRole("status", { name: "Loading email settings" })).toBeInTheDocument();
  });
});

describe("toastUndo", () => {
  it("shows a success toast with an Undo action", () => {
    const undo = vi.fn();
    toastUndo("Task completed.", undo);
    const [message, options] = toast.success.mock.calls[0]!;
    expect(message).toBe("Task completed.");
    options.action.onClick();
    expect(undo).toHaveBeenCalled();
  });
});
