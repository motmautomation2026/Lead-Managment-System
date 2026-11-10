/**
 * P7 rule 4 (fair worker ticks): the ids a worker claim may take this tick, round-robin across
 * workspaces — every workspace's first due row (by `order`) before any workspace's second — capped at
 * `limit`. So one busy workspace can never starve the others. Used inside `id in (…)` of a claim
 * that then locks with `for update skip locked` (window functions can't be locked directly).
 * `from` names the table as `x` (joins allowed); `where`, `order` and `limit` are SQL (bind parameters only).
 */
export function fairPickSql(opts: { from: string; where: string; order: string; limit: string; key?: string }): string {
  const key = opts.key ?? "x.id";
  return `select fair.k from (
      select ${key} as k, ${opts.order} as fair_at, row_number() over (partition by x.workspace_id order by ${opts.order}, ${key}) as fair_rn
        from ${opts.from}
       where ${opts.where}
    ) fair
    order by fair.fair_rn, fair.fair_at, fair.k
    limit ${opts.limit}`;
}
