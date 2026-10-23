import type { Actor } from "../authMiddleware.js";
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { AgentMode } from "../agent/rules.js";
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
  wake_min_days: number;
  wake_max_days: number;
  nurture_long_term: boolean;
  /** numeric comes back from pg as a string */
  monthly_budget_usd: string;
  decision_model: string | null;
  grounding_model: string | null;
  email_opt_out_text: string;
  whatsapp_opt_out_text: string;
  rep_quiet_hours: number;
  auto_enroll_new_leads: boolean;
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
  decisionModel: "decision_model",
  groundingModel: "grounding_model",
  emailOptOutText: "email_opt_out_text",
  whatsappOptOutText: "whatsapp_opt_out_text",
  repQuietHours: "rep_quiet_hours",
  autoEnrollNewLeads: "auto_enroll_new_leads",
};

/** How long the off → shadow switch spreads the first wakeups of already-active leads. */
const MODE_ON_SPREAD_MS = 60 * 60 * 1000;

function settingsToDto(row: SettingsRow) {
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
    wakeMinDays: row.wake_min_days,
    wakeMaxDays: row.wake_max_days,
    nurtureLongTerm: row.nurture_long_term,
    monthlyBudgetUsd: Number(row.monthly_budget_usd),
    decisionModel: row.decision_model,
    groundingModel: row.grounding_model,
    emailOptOutText: row.email_opt_out_text,
    whatsappOptOutText: row.whatsapp_opt_out_text,
    repQuietHours: row.rep_quiet_hours,
    autoEnrollNewLeads: row.auto_enroll_new_leads,
    currentPlaybookVersion: row.current_playbook_version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
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

export async function getSettings(db: Queryable, workspaceId: string) {
  return settingsToDto(await loadSettingsRow(db, workspaceId));
}

/**
 * Applies a partial update. Turning the agent on (off → shadow) queues a
 * wakeup for every lead already agent_status 'active', spread over the next
 * hour. Turning it off leaves pending wakeups alone (the 3C loop ignores
 * workspaces whose mode is off). Never touches workflows or runs.
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

    const fields = (Object.keys(COLUMNS) as (keyof SettingsUpdate)[]).filter((key) => input[key] !== undefined);
    const sets = fields.map((key, i) => `${COLUMNS[key]} = $${i + 3}`);
    const result = await client.query<SettingsRow>(
      `update public.agent_settings set ${[...sets, "updated_by = $2", "updated_at = now()"].join(", ")}
        where workspace_id = $1 returning *`,
      [workspaceId, actor.id, ...fields.map((key) => input[key])],
    );
    const updated = result.rows[0]!;

    if (current.mode === "off" && updated.mode === "shadow") {
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
    return settingsToDto(updated);
  });
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
