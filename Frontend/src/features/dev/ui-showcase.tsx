import { useState } from "react";
import { Building2, MessageCircle, Phone, Users } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DetailDrawer } from "@/components/crm/detail-drawer";
import { SaveBar } from "@/components/crm/save-bar";
import { SectionHeader } from "@/components/crm/section-layout";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { SectionTabs } from "@/components/crm/section-tabs";
import { StatusCard } from "@/components/crm/status-card";
import { InlineOwner, RowMenu } from "@/features/crm/row-controls";
import { toastUndo } from "@/lib/toast-undo";
import type { User } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef, FilterValues } from "@/components/crm/filter-model";
import { DataTable, type DataTableColumn, type SortState } from "@/components/crm/data-table";
import { RecordLayout } from "@/components/crm/record-layout";
import { PropertyList } from "@/components/crm/property-list";
import { AssociationCard } from "@/components/crm/association-card";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";

interface SampleRow {
  id: string;
  name: string;
  company: string;
  owner: string | null;
  status: string;
  tone: PillTone;
  amount: number | null;
  lastActivityAt: string;
}

const NOW = Date.now();
const SAMPLE: SampleRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: String(i + 1),
  name: ["Asha Rao", "Vikram Shah", "Meera Iyer", "Rahul Gupta"][i % 4] + ` ${i + 1}`,
  company: ["Tata Motors", "Infosys", "Zomato", "Acme Pvt Ltd"][i % 4] ?? "",
  owner: i % 5 === 0 ? null : (["Govinda", "Naitik"][i % 2] ?? null),
  status: ["New", "Qualifying", "Proposal sent", "Won", "Lost"][i % 5] ?? "",
  tone: (["info", "primary", "warning", "success", "danger"] as const)[i % 5] ?? "neutral",
  amount: i % 3 === 0 ? null : (i + 1) * 375_000,
  lastActivityAt: new Date(NOW - i * 7_200_000).toISOString(),
}));

const COLUMNS: DataTableColumn<SampleRow>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, sortable: true, hideable: false, size: 200 },
  { id: "company", header: "Company", cell: (r) => r.company, sortable: true },
  {
    id: "owner",
    header: "Owner",
    cell: (r) => (
      <span className="inline-flex items-center gap-2">
        <UserAvatar name={r.owner} size="sm" /> {r.owner ?? "Unassigned"}
      </span>
    ),
  },
  {
    id: "leadStatus",
    header: "Status",
    cell: (r) => <StatusPill tone={r.tone}>{r.status}</StatusPill>,
  },
  { id: "amount", header: "Amount", cell: (r) => <Money amount={r.amount} compact />, size: 120 },
  {
    id: "lastActivityAt",
    header: "Last activity",
    cell: (r) => <RelativeTime value={r.lastActivityAt} />,
    sortable: true,
  },
];

const FILTERS: FilterDef[] = [
  {
    id: "ownerId",
    label: "Owner",
    type: "multi",
    options: [
      { value: "me", label: "Me" },
      { value: "none", label: "No owner" },
    ],
  },
  { id: "created", label: "Created", type: "dateRange" },
  { id: "hasOpenDeal", label: "Open deal", type: "boolean" },
];
const MORE_FILTERS: FilterDef[] = [{ id: "amount", label: "Amount", type: "numberRange" }];

const TONES: PillTone[] = ["neutral", "primary", "info", "success", "warning", "danger"];

/** Every C1 building block with sample data; dev builds only (route /dev/ui). */
export function UiShowcase() {
  return (
    <div className="grid gap-px bg-border xl:grid-cols-2">
      <section className="light min-w-0 bg-background text-foreground">
        <Kit theme="Light" />
      </section>
      <section className="dark min-w-0 bg-background text-foreground">
        <Kit theme="Dark" />
      </section>
    </div>
  );
}

function Kit({ theme }: { theme: string }) {
  const [view, setView] = useState("all");
  const [filters, setFilters] = useState<FilterValues>({});
  const [sort, setSort] = useState<SortState | null>({ field: "lastActivityAt", dir: "desc" });
  const [columns, setColumns] = useState(COLUMNS.map((c) => c.id));
  const [selected, setSelected] = useState<string[]>([]);
  const [shown, setShown] = useState(20);
  const [industry, setIndustry] = useState("Automotive");

  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        title={`Contacts · ${theme}`}
        count={SAMPLE.length}
        description="PageHeader + ViewTabs + FilterBar + DataTable (server mode, sample data)."
        actions={<Button variant="outline">Import</Button>}
        primaryAction={<Button>Create contact</Button>}
        tabs={
          <ViewTabs
            views={[
              { id: "all", label: "All contacts" },
              { id: "mine", label: "My contacts" },
              { id: "recent", label: "Recently added" },
              { id: "hot", label: "Hot leads" },
              { id: "pune", label: "Pune" },
              { id: "nodeal", label: "No open deal" },
            ]}
            activeId={view}
            onChange={setView}
            onSaveView={() => undefined}
            maxVisible={4}
          />
        }
      />
      <div className="space-y-3 px-4 sm:px-6">
        <FilterBar
          filters={FILTERS}
          moreFilters={MORE_FILTERS}
          values={filters}
          onChange={setFilters}
        />
        <DataTable<SampleRow>
          label={`Sample contacts (${theme})`}
          data={SAMPLE.slice(0, shown)}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          getRowHref={() => "#"}
          onRowClick={() => undefined}
          sort={sort}
          onSortChange={setSort}
          visibleColumns={columns}
          onColumnsChange={setColumns}
          enableResizing
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={
            <Button size="sm" variant="outline">
              Assign owner
            </Button>
          }
          hasNextPage={shown < SAMPLE.length}
          onLoadMore={() => setShown((n) => Math.min(SAMPLE.length, n + 10))}
          className="max-h-96"
        />
        <div className="grid gap-3 md:grid-cols-2">
          <DataTable<SampleRow>
            label="Loading"
            data={[]}
            columns={COLUMNS.slice(0, 3)}
            getRowId={(r) => r.id}
            isLoading
            className="max-h-60"
          />
          <DataTable<SampleRow>
            label="Error"
            data={[]}
            columns={COLUMNS.slice(0, 3)}
            getRowId={(r) => r.id}
            error={new Error("Couldn't load contacts.")}
            onRetry={() => undefined}
            className="max-h-60"
          />
        </div>
      </div>

      <div className="space-y-3 px-4 sm:px-6">
        <h2 className="type-section-title">Pills, avatars, money, time</h2>
        <div className="flex flex-wrap gap-2">
          {TONES.map((t) => (
            <StatusPill key={t} tone={t} dot>
              {t}
            </StatusPill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 type-body">
          <UserAvatar name="Govinda Sharma" />
          <UserAvatar name={null} />
          <Money amount={1_250_000} />
          <Money amount={12_500_000} compact />
          <Money amount={null} />
          <RelativeTime value={new Date(NOW - 86_400_000).toISOString()} />
        </div>
        <div className="flex flex-wrap gap-2 type-small">
          <span className="type-page-title">Page title</span>
          <span className="type-section-title">Section title</span>
          <span className="type-body">Body</span>
          <span className="type-small">Small</span>
          <span className="type-label">Label</span>
        </div>
      </div>

      <div className="border-y">
        <RecordLayout
          left={
            <PropertyList
              items={[
                { id: "email", label: "Email", value: "asha@tatamotors.com" },
                { id: "owner", label: "Owner", value: "Govinda" },
                {
                  id: "industry",
                  label: "Industry",
                  value: industry,
                  editor: (done) => (
                    <Input
                      autoFocus
                      defaultValue={industry}
                      onBlur={(e) => {
                        setIndustry(e.target.value);
                        done();
                      }}
                    />
                  ),
                },
              ]}
            />
          }
          tabs={[
            {
              id: "overview",
              label: "Overview",
              content: (
                <EmptyState icon={Users} title="No activity yet" text="Log a call to start." />
              ),
            },
            { id: "activity", label: "Activity", content: <p className="type-body">Timeline…</p> },
          ]}
          right={
            <>
              <AssociationCard
                title="Company"
                items={[{ id: "c1", title: "Tata Motors", subtitle: "tatamotors.com" }]}
              />
              <AssociationCard
                title="Deals"
                items={[]}
                onAdd={() => undefined}
                emptyText="No deals yet."
              />
            </>
          }
        />
      </div>

      <Foundations theme={theme} />

      <EmptyState
        icon={Building2}
        title="Coming in the next update"
        text="EmptyState with an action."
        action={<Button size="sm">Do the thing</Button>}
      />
    </div>
  );
}

const SAMPLE_USERS = [
  { id: "u-1", name: "Asha Owner", active: true },
  { id: "u-2", name: "Ravi Rep", active: true },
] as unknown as User[];

/** UX-1 + UX-2 building blocks (C1-ui §11–13). */
function Foundations({ theme }: { theme: string }) {
  const [tab, setTab] = useState("connection");
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [label, setLabel] = useState("Sales line");
  const [saved, setSaved] = useState("Sales line");
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="space-y-4 px-4 sm:px-6">
      <SectionHeader
        title={`Foundations · ${theme}`}
        description="SectionHeader, StatusCard, SectionTabs, DetailDrawer, SaveBar, ConfirmDialog, toast + Undo, skeleton, row controls."
      />
      <StatusCard
        title="WhatsApp"
        icon={MessageCircle}
        tone="success"
        status="Connected"
        detail="2 numbers sending · 41 sent today"
        metric={{ label: "Sent today", value: "41 / 200" }}
        action={
          <Button size="sm" variant="outline">
            Open numbers
          </Button>
        }
      />
      <SectionTabs
        label="Email settings"
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            id: "connection",
            label: "Connection",
            content: (
              <div className="space-y-2 pb-16">
                <Input
                  aria-label="Label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <SaveBar
                  dirty={label !== saved}
                  saving={false}
                  onSave={() => setSaved(label)}
                  onDiscard={() => setLabel(saved)}
                />
              </div>
            ),
          },
          {
            id: "safety",
            label: "Safety & limits",
            badge: "2",
            content: <SectionSkeleton rows={2} />,
          },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setDrawer(true)}>
          Open drawer
        </Button>
        <Button variant="outline" onClick={() => setConfirm(true)}>
          Confirm dialog
        </Button>
        <Button variant="outline" onClick={() => toastUndo("Task completed", () => undefined)}>
          Toast + Undo
        </Button>
        <span className="w-44">
          <InlineOwner
            value={owner}
            users={SAMPLE_USERS}
            label="Owner (inline)"
            onChange={(id) => setOwner(SAMPLE_USERS.find((u) => u.id === id) ?? null)}
          />
        </span>
        <RowMenu label="Row actions">
          <DropdownMenuItem>
            <Phone /> Log call
          </DropdownMenuItem>
          <DropdownMenuItem>Add note</DropdownMenuItem>
        </RowMenu>
      </div>
      <DetailDrawer
        open={drawer}
        onOpenChange={setDrawer}
        title="Number #1"
        description="Not paired"
      >
        <PropertyList
          items={[
            {
              id: "status",
              label: "Status",
              value: <StatusPill tone="warning">QR ready</StatusPill>,
            },
            { id: "cap", label: "Daily cap", value: "200" },
          ]}
        />
      </DetailDrawer>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Pause sending?"
        description="No WhatsApp message is sent from this number until an admin resumes it. Queued sends wait."
        confirmLabel="Pause"
        onConfirm={() => setConfirm(false)}
      />
    </div>
  );
}
