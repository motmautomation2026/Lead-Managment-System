import type { Pool, PoolClient } from "pg";

/** Workspace-level columns of whatsapp_connection (E4a); every other setting belongs to the number. */
const WORKSPACE_COLUMNS = new Set(["send_window_days", "send_window_start", "send_window_end", "outbound_enabled", "max_numbers"]);

/**
 * E4a test helper: the workspace's whatsapp_connection row (window always open unless overridden;
 * created once) plus one connected, enabled number. Settings go to the table they live in.
 * Returns the number id. Never opens a socket.
 */
export async function connectedNumber(db: Pool | PoolClient, workspaceId: string, settings: Record<string, unknown> = {}, label = "#1"): Promise<string> {
  await db.query(
    `insert into public.whatsapp_connection (workspace_id, status, desired_state, send_window_days, send_window_start, send_window_end)
     values ($1, 'connected', 'connected', '{1,2,3,4,5,6,7}', '00:00', '23:59:59')
     on conflict (workspace_id) do nothing`,
    [workspaceId],
  );
  const created = await db.query<{ id: string }>(
    `insert into public.whatsapp_numbers (workspace_id, label, enabled, status, desired_state) values ($1, $2, true, 'connected', 'connected') returning id`,
    [workspaceId, label],
  );
  const numberId = created.rows[0]!.id;
  const entries = Object.entries(settings);
  const ws = entries.filter(([key]) => WORKSPACE_COLUMNS.has(key));
  const number = entries.filter(([key]) => !WORKSPACE_COLUMNS.has(key));
  if (ws.length) {
    await db.query(`update public.whatsapp_connection set ${ws.map(([key], i) => `${key} = $${i + 2}`).join(", ")} where workspace_id = $1`, [
      workspaceId,
      ...ws.map(([, value]) => value),
    ]);
  }
  if (number.length) {
    await db.query(`update public.whatsapp_numbers set ${number.map(([key], i) => `${key} = $${i + 2}`).join(", ")} where id = $1`, [
      numberId,
      ...number.map(([, value]) => value),
    ]);
  }
  return numberId;
}
