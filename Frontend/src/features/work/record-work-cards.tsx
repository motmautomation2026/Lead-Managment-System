import { Link } from "@tanstack/react-router";
import { AssociationCard } from "@/components/crm/association-card";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import {
  useMeetingCount,
  useMeetingList,
  useProposalCount,
  useProposalList,
  useTaskCount,
  useTaskList,
} from "@/store";

/**
 * A record's work in its Related column (C6a, used on the company record): the first 5 open
 * tasks, upcoming meetings and open proposals from the list endpoints, with counts and
 * "View all" links to the pre-filtered pages.
 */
export function RecordWorkCards({
  companyId,
  bare = false,
}: {
  companyId: string;
  /** UX-3 record rail: inside one rail card, each list under a small heading. */
  bare?: boolean;
}) {
  const filter = { companyId };
  const taskParams = { ...filter, status: "open" as const, limit: 5 };
  const meetingParams = { ...filter, when: "upcoming" as const, limit: 5 };
  const proposalParams = { ...filter, group: "open" as const, limit: 5 };
  const tasks = useTaskList(taskParams);
  const meetings = useMeetingList(meetingParams);
  const proposals = useProposalList(proposalParams);
  const taskCount = useTaskCount(taskParams).data?.count;
  const meetingCount = useMeetingCount(meetingParams).data?.count;
  const proposalCount = useProposalCount(proposalParams).data?.count;
  const rows = <T,>(list: { data?: { pages: { data: T[] }[] } | undefined }) =>
    list.data?.pages[0]?.data ?? [];

  const Card = bare ? BareCard : AssociationCard;
  return (
    <div className={bare ? "space-y-4" : "contents"}>
      <Card
        title="Open tasks"
        {...(taskCount !== undefined ? { count: taskCount } : {})}
        emptyText="No open tasks."
        footer={
          <Link
            aria-label="View all tasks"
            to="/tasks"
            search={{ companyId, view: "everyone" }}
            className="type-small text-primary hover:underline"
          >
            View all
          </Link>
        }
        items={rows(tasks).map((t) => ({
          id: t.id,
          title: t.title,
          subtitle: `${t.contact.name}${t.ownerName ? ` · ${t.ownerName}` : ""}`,
          meta: <RelativeTime value={t.dueAt} className={t.isOverdue ? "text-destructive" : ""} />,
        }))}
      />
      <Card
        title="Upcoming meetings"
        {...(meetingCount !== undefined ? { count: meetingCount } : {})}
        emptyText="No upcoming meetings."
        footer={
          <Link
            aria-label="View all meetings"
            to="/meetings"
            search={{ companyId, view: "upcoming", when: "upcoming" }}
            className="type-small text-primary hover:underline"
          >
            View all
          </Link>
        }
        items={rows(meetings).map((m) => ({
          id: m.id,
          title: m.title,
          subtitle: m.contact.name,
          meta: <RelativeTime value={m.at} />,
        }))}
      />
      <Card
        title="Open proposals"
        {...(proposalCount !== undefined ? { count: proposalCount } : {})}
        emptyText="No open proposals."
        footer={
          <Link
            aria-label="View all proposals"
            to="/proposals"
            search={{ companyId, view: "open", group: "open" }}
            className="type-small text-primary hover:underline"
          >
            View all
          </Link>
        }
        items={rows(proposals).map((p) => ({
          id: p.id,
          title: p.title,
          subtitle: p.contact.name,
          meta: <StatusBadge value={p.status} />,
        }))}
      />
    </div>
  );
}

function BareCard(props: Parameters<typeof AssociationCard>[0]) {
  return (
    <section className="space-y-1">
      <h3 className="type-label">
        {props.title}
        {props.count !== undefined && (
          <span className="ml-1 num font-normal text-muted-foreground">({props.count})</span>
        )}
      </h3>
      <AssociationCard {...props} bare />
    </section>
  );
}
