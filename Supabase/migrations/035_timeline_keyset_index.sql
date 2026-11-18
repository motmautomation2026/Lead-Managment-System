-- =============================================================================
-- Northbeam CRM -- paginated timelines (C3)
-- =============================================================================
--
-- GET /contacts/:id/timeline and /companies/:id/timeline page newest first on
-- (occurred_at, id) (Backend/src/services/timeline.service.ts). The existing
-- (lead_id, occurred_at desc) index has no id tie-break. related_deal_id is
-- already indexed (032). Additive and re-runnable; one index only.

create index if not exists timeline_events_lead_occurred_id_idx
  on public.timeline_events (lead_id, occurred_at, id);
