import type { Actor } from "../authMiddleware.js";
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../errors.js";
import type { AgentMode } from "../agent/rules.js";
import { canSetScope, type LiveScope } from "../agent/liveMode.js";
import { cancelWorkflowsOfLiveContacts, liveContactSql } from "./agentSendState.service.js";
import { loadReadiness } from "./agentReview.service.js";
import { settingsCrossFieldProblems, type SettingsUpdate } from "../agent/settingsSchema.js";
import { enqueueWakeups } from "./agentWakeups.service.js";

interface SettingsRow {
  workspace_id: string;
  mode: AgentMode;
  send_days: number[];
  send_window_start: string;
  send_window_end: string;
  min_gap_hours: number;
  max_touches_7d: number;
  max_touches_total: number;
  email_max_words: number;
  whatsapp_max_words: number;
  banned_phrases: string[];
  target_industry_keywords: string[];
  style_examples: string;
  first_channel: "whatsapp" | "email";
  wake_min_days: number;
  wake_max_days: number;
  nurture_long_term: boolean;
  /** numeric comes back from pg as a string */
  monthly_budget_usd: string;
  max_decisions_per_day: number;
  decision_model: string | null;
  grounding_model: string | null;
  email_opt_out_text: string;
  whatsapp_opt_out_text: string;
  rep_quiet_hours: number;
  auto_enroll_new_leads: boolean;
  company_display_name: string | null;
  live_scope: LiveScope;
  live_since: Date | null;
  readiness_since: Date | null;
  current_playbook_version: number | null;
  updated_by: string | null;
  updated_at: Date;
}

/** API field → column, for every field a PUT may change. */
const COLUMNS: Record<keyof SettingsUpdate, keyof SettingsRow> = {
  mode: "mode",
  sendDays: "send_days",
  sendWindowStart: "send_window_start",
  sendWindowEnd: "send_window_end",
  minGapHours: "min_gap_hours",
  maxTouches7d: "max_touches_7d",
  maxTouchesTotal: "max_touches_total",
  emailMaxWords: "email_max_words",
  whatsappMaxWords: "whatsapp_max_words",
  wakeMinDays: "wake_min_days",
  wakeMaxDays: "wake_max_days",
  nurtureLongTerm: "nurture_long_term",
  monthlyBudgetUsd: "monthly_budget_usd",
  maxDecisionsPerDay: "max_decisions_per_day",
  decisionModel: "decision_model",
  groundingModel: "grounding_model",
  emailOptOutText: "email_opt_out_text",
  whatsappOptOutText: "whatsapp_opt_out_text",
  repQuietHours: "rep_quiet_hours",
  autoEnrollNewLeads: "auto_enroll_new_leads",
  companyDisplayName: "company_display_name",
  liveScope: "live_scope",
  bannedPhrases: "banned_phrases",
  targetIndustryKeywords: "target_industry_keywords",
  styleExamples: "style_examples",
  firstChannel: "first_channel",
};

/** How long the off → shadow switch spreads the first wakeups of already-active leads. */
const MODE_ON_SPREAD_MS = 60 * 60 * 1000;

/** `activeLeadCount`: leads agent_status 'active', the ones the off → shadow switch wakes; `liveContactCount`: AI contacts live now (E2). */
function settingsToDto(row: SettingsRow, activeLeadCount: number, liveContactCount: number) {
  return {
    mode: row.mode,
    sendDays: row.send_days,
    sendWindowStart: row.send_window_start.slice(0, 5),
    sendWindowEnd: row.send_window_end.slice(0, 5),
    minGapHours: row.min_gap_hours,
    maxTouches7d: row.max_touches_7d,
    maxTouchesTotal: row.max_touches_total,
    emailMaxWords: row.email_max_words,
    whatsappMaxWords: row.whatsapp_max_words,
    bannedPhrases: row.banned_phrases,
    targetIndustryKeywords: row.target_industry_keywords,
    styleExamples: row.style_examples,
    firstChannel: row.first_channel,
    wakeMinDays: row.wake_min_days,
    wakeMaxDays: row.wake_max_days,
    nurtureLongTerm: row.nurture_long_term,
    monthlyBudgetUsd: Number(row.monthly_budget_usd),
    maxDecisionsPerDay: row.max_decisions_per_day,
    decisionModel: row.decision_model,
    groundingModel: row.grounding_model,
    emailOptOutText: row.email_opt_out_text,
    whatsappOptOutText: row.whatsapp_opt_out_text,
    repQuietHours: row.rep_quiet_hours,
    autoEnrollNewLeads: row.auto_enroll_new_leads,
    companyDisplayName: row.company_display_name,
    liveScope: row.live_scope,
    liveSince: row.live_since?.toISOString() ?? null,
    readinessSince: row.readiness_since?.toISOString() ?? null,
    liveContactCount,
    currentPlaybookVersion: row.current_playbook_version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    activeLeadCount,
  };
}

async function countActiveLeads(db: Queryable, workspaceId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from public.leads where workspace_id = $1 and agent_status = 'active'`,
    [workspaceId],
  );
  return result.rows[0]!.n;
}

async function loadSettingsRow(db: Queryable, workspaceId: string, forUpdate = false): Promise<SettingsRow> {
  const result = await db.query<SettingsRow>(
    `select * from public.agent_settings where workspace_id = $1${forUpdate ? " for update" : ""}`,
    [workspaceId],
  );
  // Seeded for every workspace by migration 024's trigger.
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Agent settings");
  return row;
}

/** AI contacts that would be live with this scope (and live_since), and their unfinished workflow runs. */
async function countLive(db: Queryable, workspaceId: string, scope: LiveScope, since: Date | null) {
  const result = await db.query<{ contacts: number; runs: number }>(
    `select count(*)::int as contacts,
            coalesce(sum((select count(*) from public.workflow_runs r where r.lead_id = l.id and r.status not in ('completed', 'cancelled'))), 0)::int as runs
       from public.leads l where l.workspace_id = $1 and ${liveContactSql("$2::text", "$3")}`,
    [workspaceId, scope, since],
  );
  return result.rows[0]!;
}

const liveCount = async (db: Queryable, row: SettingsRow) => (row.mode === "live" ? (await countLive(db, row.workspace_id, row.live_scope, row.live_since)).contacts : 0);

export async function getSettings(db: Queryable, workspaceId: string) {
  const row = await loadSettingsRow(db, workspaceId);
  return settingsToDto(row, await countActiveLeads(db, workspaceId), await liveCount(db, row));
}

/**
 * E2: what switching to Live with `scope` would do, for the confirm dialog (nothing changes):
 * the go-live gate, whether the scope is allowed, how many AI contacts become live and how
 * many of their workflow runs get cancelled.
 */
export async function getLivePreview(db: Queryable, workspaceId: string, scope: LiveScope) {
  const [current, readiness] = await Promise.all([loadSettingsRow(db, workspaceId), loadReadiness(db, workspaceId)]);
  // new_leads counts from the switch-on moment (now) unless it is already on.
  const since = scope === "new_leads" ? (current.mode === "live" && current.live_scope === "new_leads" ? current.live_since : new Date()) : null;
  const allowed = canSetScope(scope, readiness);
  const counts = await countLive(db, workspaceId, scope, since);
  return { scope, readiness, allowed: allowed.ok, message: allowed.ok ? null : allowed.message, liveContacts: counts.contacts, workflowRunsToCancel: counts.runs };
}

/**
 * Applies a partial update. Turning the agent on (off → shadow/live) queues a
 * wakeup for every lead already agent_status 'active', spread over the next
 * hour. Turning it off leaves pending wakeups alone (the 3C loop ignores
 * workspaces whose mode is off). E2: switching into Live or changing the live scope
 * needs the go-live gate for new_leads/all (422 with the numbers); switching
 * new_leads on sets live_since; contacts that are live afterwards leave their
 * workflows (rule 9). Leaving Live cancels nothing directly: queued sends are
 * cancelled by the send-time re-check (rule 10).
 */
export async function updateSettings(actor: Actor, workspaceId: string, input: SettingsUpdate) {
  return withTransaction(async (client) => {
    const current = await loadSettingsRow(client, workspaceId, true);
    const merged = {
      sendWindowStart: input.sendWindowStart ?? current.send_window_start,
      sendWindowEnd: input.sendWindowEnd ?? current.send_window_end,
      wakeMinDays: input.wakeMinDays ?? current.wake_min_days,
      wakeMaxDays: input.wakeMaxDays ?? current.wake_max_days,
    };
    const problem = settingsCrossFieldProblems(merged)[0];
    if (problem) throw new ValidationError(problem.message, { fieldErrors: { [problem.path[0]!]: [problem.message] } });

    const nextMode = input.mode ?? current.mode;
    const nextScope = input.liveScope ?? current.live_scope;
    const switching = (nextMode === "live" && current.mode !== "live") || nextScope !== current.live_scope;
    if (nextMode === "live" && switching) {
      const readiness = await loadReadiness(client, workspaceId);
      const allowed = canSetScope(nextScope, readiness);
      if (!allowed.ok) throw new InvalidTransitionError(allowed.message, { readiness });
    }

    const fields = (Object.keys(COLUMNS) as (keyof SettingsUpdate)[]).filter((key) => input[key] !== undefined);
    const sets = fields.map((key, i) => `${COLUMNS[key]} = $${i + 3}`);
    const result = await client.query<SettingsRow>(
      `update public.agent_settings set ${[...sets, "updated_by = $2", "updated_at = now()"].join(", ")}
        where workspace_id = $1 returning *`,
      [workspaceId, actor.id, ...fields.map((key) => input[key])],
    );
    let updated = result.rows[0]!;
    if (updated.mode === "live" && updated.live_scope === "new_leads" && !(current.mode === "live" && current.live_scope === "new_leads")) {
      updated = (await client.query<SettingsRow>(`update public.agent_settings set live_since = now() where workspace_id = $1 returning *`, [workspaceId])).rows[0]!;
    }

    if (current.mode === "off" && updated.mode !== "off") {
      const leads = await client.query<{ id: string }>(
        `select id from public.leads where workspace_id = $1 and agent_status = 'active' order by id`,
        [workspaceId],
      );
      const start = Date.now();
      const step = leads.rows.length ? MODE_ON_SPREAD_MS / leads.rows.length : 0;
      await enqueueWakeups(
        client,
        workspaceId,
        leads.rows.map((lead, i) => ({ leadId: lead.id, dueAt: new Date(start + i * step) })),
        "resumed",
        { source: "mode_on" },
      );
    }
    if (updated.mode === "live") await cancelWorkflowsOfLiveContacts(client, workspaceId);
    return settingsToDto(updated, await countActiveLeads(client, workspaceId), await liveCount(client, updated));
  });
}

/**
 * E2f: "Reset go-live count". The gate counts only decisions created from now on; earlier
 * ratings stay saved (and visible) but no longer count.
 */
export async function resetReadiness(db: Queryable, actor: Actor, workspaceId: string) {
  const result = await db.query<SettingsRow>(
    `update public.agent_settings set readiness_since = now(), updated_by = $2, updated_at = now() where workspace_id = $1 returning *`,
    [workspaceId, actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Agent settings");
  return settingsToDto(row, await countActiveLeads(db, workspaceId), await liveCount(db, row));
}

// --- Playbooks ----------------------------------------------------------------

interface PlaybookRow {
  id: string;
  version: number;
  body: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
}

const playbookToDto = (row: PlaybookRow) => ({
  id: row.id,
  version: row.version,
  body: row.body,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  createdAt: row.created_at.toISOString(),
});

export async function listPlaybooks(db: Queryable, workspaceId: string) {
  const [settings, rows] = await Promise.all([
    loadSettingsRow(db, workspaceId),
    db.query<PlaybookRow>(
      `select id, version, body, created_by, created_by_name, created_at
         from public.agent_playbooks where workspace_id = $1 order by version desc limit 50`,
      [workspaceId],
    ),
  ]);
  return { currentVersion: settings.current_playbook_version, data: rows.rows.map(playbookToDto) };
}

/** New version = max + 1 and becomes current. The settings row lock serialises concurrent saves. */
async function insertPlaybookVersion(client: Queryable, actor: Actor, workspaceId: string, body: string) {
  await loadSettingsRow(client, workspaceId, true);
  const inserted = await client.query<PlaybookRow>(
    `insert into public.agent_playbooks (workspace_id, version, body, created_by, created_by_name)
     select $1, coalesce(max(version), 0) + 1, $2, $3, $4 from public.agent_playbooks where workspace_id = $1
     returning id, version, body, created_by, created_by_name, created_at`,
    [workspaceId, body, actor.id, actor.fullName],
  );
  const row = inserted.rows[0]!;
  await client.query(
    `update public.agent_settings set current_playbook_version = $2, updated_by = $3, updated_at = now() where workspace_id = $1`,
    [workspaceId, row.version, actor.id],
  );
  return playbookToDto(row);
}

export async function createPlaybookVersion(actor: Actor, workspaceId: string, body: string) {
  return withTransaction((client) => insertPlaybookVersion(client, actor, workspaceId, body));
}

/** Restoring copies the old body into a NEW version, so history stays linear. */
export async function restorePlaybookVersion(actor: Actor, workspaceId: string, version: number) {
  return withTransaction(async (client) => {
    const old = await client.query<{ body: string }>(
      `select body from public.agent_playbooks where workspace_id = $1 and version = $2`,
      [workspaceId, version],
    );
    const row = old.rows[0];
    if (!row) throw new NotFoundError("Playbook version");
    return insertPlaybookVersion(client, actor, workspaceId, row.body);
  });
}
