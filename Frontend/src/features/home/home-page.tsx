import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarDays,
  CheckSquare,
  FileText,
  Handshake,
  Plus,
  Sparkles,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { ErrorBlock } from "@/components/common/server-state";
import { useAddLead, useCreateDealDialog, useCreateTaskDialog } from "@/app/add-lead-context";
import { DEAL_STAGE_LABELS } from "@/features/deals/deal-labels";
import { joinLink } from "@/features/meetings/meeting-labels";
import { RefLink } from "@/features/work/ref-link";
import { fmtDateTime } from "@/lib/format";
import { useHomeSummary, useSession } from "@/store";
import type { HomeSummary } from "@/types";

/**
 * Home (`/`, C6b): the signed-in user's day from GET /home/summary. Every number comes from
 * the backend (IST days in SQL); each card links to the list that shows the same rows.
 */
export function HomePage() {
  const summary = useHomeSummary();
  const { currentUser } = useSession();
  const addContact = useAddLead();
  const createTask = useCreateTaskDialog();
  const createDeal = useCreateDealDialog();

  return (
    <div className="pb-24">
      <PageHeader
        title="Home"
        description={currentUser ? `Your day, ${currentUser.name.split(" ")[0]}.` : "Your day."}
        actions={
          <>
            <Button variant="outline" onClick={() => addContact.open()}>
              <Plus /> Contact
            </Button>
            <Button variant="outline" onClick={() => createTask.open()}>
              <Plus /> Task
            </Button>
          </>
        }
        primaryAction={
          <Button onClick={() => createDeal.open()}>
            <Plus /> Deal
          </Button>
        }
      />
      <div className="px-4 pt-4 sm:px-6">
        {summary.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading Home">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        ) : summary.error || !summary.data ? (
          <div className="space-y-2">
            <ErrorBlock error={summary.error} />
            <Button variant="outline" onClick={() => void summary.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <HomeCards data={summary.data} />
        )}
      </div>
    </div>
  );
}

function HomeCards({ data }: { data: HomeSummary }) {
  const { tasks, meetings, deals, proposals, ai } = data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:row-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="type-section-title">My day</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Overdue"
              value={tasks.overdue}
              danger={tasks.overdue > 0}
              link={
                <Link
                  to="/tasks"
                  search={{ view: "overdue", ownerId: ["me"], due: "overdue" }}
                  className="hover:underline"
                >
                  Overdue tasks
                </Link>
              }
            />
            <Stat
              label="Due today"
              value={tasks.dueToday}
              link={
                <Link
                  to="/tasks"
                  search={{ view: "today", ownerId: ["me"], due: "today" }}
                  className="hover:underline"
                >
                  Due today
                </Link>
              }
            />
            <Stat
              label="Need an outcome"
              value={meetings.needsOutcome}
              danger={meetings.needsOutcome > 0}
              link={
                <Link
                  to="/meetings"
                  search={{
                    view: "needs_outcome",
                    when: "needs_outcome",
                    ownerId: ["me"],
                    sort: "at:desc",
                  }}
                  className="hover:underline"
                >
                  Meetings needing an outcome
                </Link>
              }
            />
          </div>

          <section aria-label="Next tasks" className="space-y-2">
            <SectionTitle icon={CheckSquare} title="Next tasks">
              <Link
                to="/tasks"
                search={{ view: "mine", ownerId: ["me"] }}
                className="type-small text-primary hover:underline"
              >
                All my tasks
              </Link>
            </SectionTitle>
            {tasks.next.length === 0 ? (
              <p className="type-body text-muted-foreground">No open tasks. Nice.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {tasks.next.map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate type-body font-medium">{t.title}</div>
                      <div className="truncate type-small text-muted-foreground">
                        <RefLink type="contact" value={t.contact} />
                      </div>
                    </div>
                    <RelativeTime
                      value={t.dueAt}
                      className={`shrink-0 type-small ${t.isOverdue ? "text-destructive" : "text-muted-foreground"}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Today's meetings" className="space-y-2">
            <SectionTitle icon={CalendarDays} title={`Today's meetings (${meetings.todayCount})`}>
              <Link
                to="/meetings"
                search={{ view: "today", when: "today", ownerId: ["me"] }}
                className="type-small text-primary hover:underline"
              >
                All today
              </Link>
            </SectionTitle>
            {meetings.today.length === 0 ? (
              <p className="type-body text-muted-foreground">No meetings left today.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {meetings.today.map((m) => {
                  const href = joinLink(m);
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate type-body font-medium">{m.title}</div>
                        <div className="truncate type-small text-muted-foreground">
                          {fmtDateTime(m.at)} · <RefLink type="contact" value={m.contact} />
                        </div>
                      </div>
                      {href && (
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Join ${m.title}`}
                          >
                            <Video /> Join
                          </a>
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="type-section-title">My pipeline</CardTitle>
          <Link
            to="/deals"
            search={{ layout: "board", view: "mine", ownerId: ["me"] }}
            className="type-small text-primary hover:underline"
          >
            Open the board
          </Link>
        </CardHeader>
        <CardContent className="space-y-3">
          {deals.openCount === 0 ? (
            <EmptyState
              icon={Handshake}
              title="No open deals"
              text="Create a deal from a contact."
            />
          ) : (
            <>
              <div className="flex items-baseline gap-3">
                <span className="num text-2xl font-semibold">{deals.openCount}</span>
                <span className="type-body text-muted-foreground">
                  open {deals.openCount === 1 ? "deal" : "deals"} ·{" "}
                  <Money amount={deals.openAmount} compact />
                </span>
              </div>
              <StageBars stages={deals.stages} />
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-1 p-4">
            <div className="flex items-center gap-2 type-label">
              <FileText className="size-4" /> Proposals awaiting decision
            </div>
            <div className="num text-2xl font-semibold">{proposals.awaitingDecision}</div>
            <Link
              to="/proposals"
              search={{ view: "awaiting", group: "awaiting_decision", ownerId: ["me"] }}
              className="type-small text-primary hover:underline"
            >
              View proposals
            </Link>
          </CardContent>
        </Card>
        {ai && (
          <Card>
            <CardContent className="space-y-1 p-4">
              <div className="flex items-center gap-2 type-label">
                <Sparkles className="size-4" /> AI drafts to review
              </div>
              <div className="num text-2xl font-semibold">{ai.draftsToReview}</div>
              <Link
                to="/ai-activity"
                search={{ outcome: "draft", rating: "unrated" }}
                className="type-small text-primary hover:underline"
              >
                Review in AI Activity
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  danger = false,
  link,
}: {
  label: string;
  value: number;
  danger?: boolean;
  link: ReactNode;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className={`num text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>
        {value}
      </div>
      <div className="type-small text-muted-foreground">{label}</div>
      <div className="mt-1 type-small text-primary">{link}</div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof CheckSquare;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 type-label">
        <Icon className="size-4" /> {title}
      </h3>
      {children}
    </div>
  );
}

/** Open stages as CSS bars: the width is only the count relative to the largest stage. */
function StageBars({ stages }: { stages: HomeSummary["deals"]["stages"] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <ul className="space-y-1.5" aria-label="Open deals per stage">
      {stages.map((s) => (
        <li key={s.stage} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-2 type-small">
          <Link
            to="/deals"
            search={{ layout: "board", view: "mine", ownerId: ["me"] }}
            className="truncate hover:underline"
          >
            {DEAL_STAGE_LABELS[s.stage]}
          </Link>
          <span className="h-2 rounded-full bg-muted" aria-hidden="true">
            <span
              className="block h-2 rounded-full bg-primary"
              style={{ width: `${(s.count / max) * 100}%` }}
            />
          </span>
          <span className="num text-right">{s.count}</span>
        </li>
      ))}
    </ul>
  );
}
