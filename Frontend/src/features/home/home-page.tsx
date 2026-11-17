import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarDays,
  CheckSquare,
  Clock,
  FileText,
  Handshake,
  MessageSquareReply,
  Phone,
  Plus,
  Signpost,
  Sparkles,
  Users,
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
import { ConversionCard } from "@/features/analytics/funnel";
import type { HomeSummary, TaskListItem } from "@/types";

/** "Good morning" by the IST hour (the CRM's day is IST everywhere). */
function greeting(now: Date) {
  const hour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}
const todayIst = (now: Date) =>
  now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

/**
 * Home (`/`, UX-3 "My day"): the signed-in user's queues from GET /home/summary — every count and list
 * comes from the backend (IST days in SQL) and each card links to the queue or list with the same rows.
 * Admins also see the team row and this workspace's red flags.
 */
export function HomePage() {
  const summary = useHomeSummary();
  const { currentUser } = useSession();
  const addContact = useAddLead();
  const createTask = useCreateTaskDialog();
  const createDeal = useCreateDealDialog();
  const now = new Date();
  const first = currentUser?.name.split(" ")[0];

  return (
    <div className="pb-24">
      <PageHeader
        title="Home"
        description={`${greeting(now)}${first ? `, ${first}` : ""} · ${todayIst(now)}`}
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
          <div
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-busy="true"
            aria-label="Loading Home"
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-44 w-full" />
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
  const { tasks, meetings, deals, proposals, ai, replies, calls, nextSteps } = data;
  const me = { ownerId: ["me"] };
  return (
    <div className="space-y-6">
      {data.flags && <RedFlags flags={data.flags} />}

      <section aria-label="My day" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <QueueCard
          icon={MessageSquareReply}
          title="Replies waiting"
          count={replies.count}
          urgent
          empty="No replies waiting."
          items={replies.top}
          link={
            <Link to="/tasks/replies" className="hover:underline">
              Open the Replies queue
            </Link>
          }
        />
        <QueueCard
          icon={Phone}
          title="Calls due today / overdue"
          count={calls.count}
          empty="No calls due. You're up to date."
          items={calls.top}
          link={
            <Link to="/tasks/calls" className="hover:underline">
              Start calling
            </Link>
          }
        />
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 type-section-title">
              <CalendarDays className="size-4" aria-hidden="true" /> Meetings today
            </CardTitle>
            <span className="num text-2xl font-semibold">{meetings.todayCount}</span>
          </CardHeader>
          <CardContent className="space-y-2">
            {meetings.today.length === 0 ? (
              <p className="type-body text-muted-foreground">No meetings left today.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {meetings.today.slice(0, 5).map((m) => {
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
            <p className="type-small text-primary">
              <Link
                to="/meetings"
                search={{ view: "today", when: "today", ...me }}
                className="hover:underline"
              >
                All meetings today
              </Link>
              {meetings.needsOutcome > 0 && (
                <>
                  {" · "}
                  <Link
                    to="/meetings"
                    search={{
                      view: "needs_outcome",
                      when: "needs_outcome",
                      ...me,
                      sort: "at:desc",
                    }}
                    className="text-destructive hover:underline"
                  >
                    {meetings.needsOutcome} need an outcome
                  </Link>
                </>
              )}
            </p>
          </CardContent>
        </Card>
        <QueueCard
          icon={Signpost}
          title="Decide the next step"
          count={nextSteps.count}
          empty="No contacts waiting for a next step."
          items={nextSteps.top}
          link={
            <Link
              to="/tasks"
              search={{ view: "mine", ...me, q: "Decide the next step" }}
              className="hover:underline"
            >
              All next-step tasks
            </Link>
          }
        />
        <QueueCard
          icon={Clock}
          title="Overdue tasks"
          count={tasks.overdue}
          urgent
          empty="Nothing overdue. Nice."
          items={tasks.overdueTop}
          link={
            <Link
              to="/tasks"
              search={{ view: "overdue", ...me, due: "overdue" }}
              className="hover:underline"
            >
              All overdue tasks
            </Link>
          }
        />
        <QueueCard
          icon={CheckSquare}
          title="Due today"
          count={tasks.dueToday}
          empty="Nothing else due today."
          items={tasks.next}
          link={
            <Link
              to="/tasks"
              search={{ view: "today", ...me, due: "today" }}
              className="hover:underline"
            >
              Due today
            </Link>
          }
        />
      </section>

      {data.team && <TeamRow team={data.team} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="type-section-title">My pipeline</CardTitle>
            <Link
              to="/deals"
              search={{ layout: "board", view: "mine", ...me }}
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
                search={{ view: "awaiting", group: "awaiting_decision", ...me }}
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
          <div className="sm:col-span-2">
            <ConversionCard />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One "My day" card: the count, the top items (title · contact) and the one link to the queue. */
function QueueCard({
  icon: Icon,
  title,
  count,
  items,
  empty,
  link,
  urgent = false,
}: {
  icon: typeof Clock;
  title: string;
  count: number;
  items: TaskListItem[];
  empty: string;
  link: ReactNode;
  urgent?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 type-section-title">
          <Icon className="size-4" aria-hidden="true" /> {title}
        </CardTitle>
        <span
          className={`num text-2xl font-semibold ${urgent && count > 0 ? "text-destructive" : ""}`}
          aria-label={`${count} ${title.toLowerCase()}`}
        >
          {count}
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="type-body text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.slice(0, 5).map((t) => (
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
        <p className="type-small text-primary">{link}</p>
      </CardContent>
    </Card>
  );
}

/** Admins: this workspace's red problems from System health (and the LL-2 "no mailbox" warning). */
function RedFlags({ flags }: { flags: NonNullable<HomeSummary["flags"]> }) {
  if (flags.length === 0)
    return (
      <p className="flex items-center gap-2 type-small text-muted-foreground" role="status">
        No red flags in this workspace.
      </p>
    );
  return (
    <section
      aria-label="Red flags"
      className="space-y-1.5 rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-danger-soft-foreground"
    >
      {flags.map((f) => (
        <p key={f.code} className="flex items-start gap-2 type-body">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {f.text}{" "}
            {f.code === "staff_email_no_mailbox" ? (
              <Link to="/settings/email" className="font-medium underline">
                Settings → Email
              </Link>
            ) : f.code === "paused_channel" ? (
              <Link to="/settings/whatsapp" className="font-medium underline">
                Channels
              </Link>
            ) : null}
          </span>
        </p>
      ))}
    </section>
  );
}

/** Admins: per rep, open tasks · overdue · replies waiting (busiest first). */
function TeamRow({ team }: { team: NonNullable<HomeSummary["team"]> }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 type-section-title">
          <Users className="size-4" aria-hidden="true" /> Team
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {team.length === 0 ? (
          <p className="type-body text-muted-foreground">No active members yet.</p>
        ) : (
          <table className="w-full text-sm" aria-label="Team">
            <thead>
              <tr className="text-left type-label">
                <th className="py-1.5 pr-3 font-medium">Rep</th>
                <th className="py-1.5 pr-3 text-right font-medium">Open tasks</th>
                <th className="py-1.5 pr-3 text-right font-medium">Overdue</th>
                <th className="py-1.5 text-right font-medium">Replies waiting</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {team.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pr-3">
                    <Link
                      to="/tasks"
                      search={{ view: "everyone", ownerId: [r.id] }}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="num py-1.5 pr-3 text-right">{r.openTasks}</td>
                  <td
                    className={`num py-1.5 pr-3 text-right ${r.overdue > 0 ? "text-destructive" : ""}`}
                  >
                    {r.overdue}
                  </td>
                  <td className="num py-1.5 text-right">{r.replies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
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
