/**
 * npm run staging:seed-ai-test-contacts [-- --confirm]
 * npm run staging:remove-ai-test-contacts [-- --confirm]
 * npm run staging:repair-ai-test-contacts [-- --confirm]
 *
 * STAGING ONLY (E2e): creates ~20 realistic AI test contacts in the MOTM workspace through the real services
 * (website form ingest, createLead, logCall, addNote, meetings, proposals), enrols them in the AI agent and,
 * when the workspace isn't off, spreads their first wake-ups over 2 hours. Nothing is sent: they are never marked
 * "AI live test", so the agent only drafts for them (shadow, or live with scope test_contacts).
 * Marker: leads.created_by_name = 'AI test seed' (removal also requires a seeded email/phone).
 * --repair (E2f): restores each seeded contact's company text (the domain bug linked every @example.com contact to the
 * first one's company), relinks it with the fixed linking, dismisses the stale contact-level duplicate rows, and lists
 * (changes nothing) NON-seeded contacts that were linked to a differently named company by domain.
 * Default is a dry run; --confirm writes. Refuses any database but the staging project.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePhoneE164 } from "../src/domain/phone.js";
import type { LogCallInput } from "../src/services/calls.service.js";
import type { CreateLeadInput } from "../src/services/leads.service.js";
import type { MeetingOutcome } from "../src/domain/enums.js";

export const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
export const STAGING_REF = "arejsxqjhzotmngrobhm";
export const MOTM_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
export const SEED_MARKER = "AI test seed";
const WAKE_SPREAD_MS = 2 * 60 * 60 * 1000;

export function assertStagingDatabase(url: string | undefined): void {
  if (url?.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL points at the production project; refusing.");
  if (!url?.includes(STAGING_REF)) throw new Error(`DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`);
}

/** One step of a contact's history; `daysAgo` backdates the timeline rows the step wrote. */
export type SeedStep = { daysAgo?: number } & (
  | { call: LogCallInput }
  | { note: string }
  | { meeting: { title: string; atDaysAgo: number; outcome: MeetingOutcome; notes: string } }
  | { proposal: { title: string; amount: number; sentDaysAgo: number } }
);

export interface SeedScenario {
  firstName: string;
  lastName: string;
  company: string;
  scenario: string;
  /** 1–20: phone +91 90000 000NN. */
  phoneNo: number;
  /** false = no email (thin lead: name + phone only). */
  email?: false;
  /** Website form (ingestWebsiteLead) with this message, else createLead with these fields. */
  website?: { message: string; company?: string };
  lead?: Pick<CreateLeadInput, "source" | "industry" | "jobTitle" | "revenueRange">;
  /** Backdates the creation rows (Lead Created, assignment, …). */
  createdDaysAgo?: number;
  steps?: SeedStep[];
}

export const seedEmail = (s: SeedScenario) => (s.email === false ? null : `${s.firstName}.${s.lastName}@example.com`.toLowerCase());
export const seedPhone = (s: SeedScenario) => `+91 90000 000${String(s.phoneNo).padStart(2, "0")}`;

const form = (challenge: string, industry: string, revenue: string) => `${challenge}\nIndustry: ${industry}\nRevenue range: ${revenue}`;

/** The company the scenario meant (what the form or createLead was given); "" = none. */
export const seedCompany = (s: SeedScenario) => s.website?.company ?? s.company;

/** Next Monday 11:00 IST (UTC+05:30), always in the future. */
function nextMondayIst(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const days = ((8 - ist.getUTCDay()) % 7) || 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 5, 30)).toISOString();
}

export const SCENARIOS: SeedScenario[] = [
  // 6 new website enquiries, each with a different problem.
  {
    firstName: "Rakesh", lastName: "Sharda", company: "Sharda Hydraulics Pvt Ltd", phoneNo: 1,
    scenario: "Website: precision components maker wants more OEM buyers",
    website: { message: form("We machine precision hydraulic fittings and valve blocks. Most of our business comes from two OEMs and we want to add more OEM buyers in auto and tractor segments.", "Precision Components", "₹10–50 Cr") },
  },
  {
    firstName: "Meena", lastName: "Kulkarni", company: "Vedant Automation Systems", phoneNo: 2,
    scenario: "Website: automation company, many enquiries but few orders",
    website: { message: form("We get 40-50 enquiries a month for our PLC panels and SPMs but very few turn into orders. Quotes go out and then nothing happens.", "Industrial Automation", "₹5–10 Cr") },
  },
  {
    firstName: "Suresh", lastName: "Agarwal", company: "Agarwal Steel Traders", phoneNo: 3,
    scenario: "Website: steel trader wants repeat buyers",
    website: { message: form("We trade HR/CR coils and structural steel. Buyers come once for a project and do not come back. We want repeat buyers, not one-time orders.", "Steel Trading", "₹50–100 Cr") },
  },
  {
    firstName: "Imran", lastName: "Shaikh", company: "Aquaflow Pumps Pvt Ltd", phoneNo: 4,
    scenario: "Website: industrial pump maker wants Middle East distributors",
    website: { message: form("We manufacture centrifugal and submersible pumps. We want export distributors in the Middle East - UAE, Saudi and Oman - but we have no contacts there.", "Industrial Pumps", "₹10–50 Cr") },
  },
  {
    firstName: "Lakshmi", lastName: "Narayanan", company: "Pureflow Water Engineering", phoneNo: 5,
    scenario: "Website: EPC / water-treatment firm relies on referrals",
    website: { message: form("We do EPC for ETP and STP plants. All our projects so far came through referrals from consultants. We have no system to find new clients ourselves.", "Water Treatment EPC", "₹10–50 Cr") },
  },
  {
    firstName: "Harish", lastName: "Patel", company: "Patel Fabrication Works", phoneNo: 6,
    scenario: "Website: small founder-led fabrication shop, founder does all sales",
    website: { message: form("Small fabrication shop, 25 people. I am the owner and I do all the sales myself along with production. I don't get time to follow up with customers.", "Sheet Metal Fabrication", "₹1–5 Cr") },
  },
  // 2 thin website leads.
  {
    firstName: "Ajay", lastName: "Verma", company: "", phoneNo: 7, email: false,
    scenario: "Thin website lead: name + phone only, no message",
    website: { message: "" },
  },
  {
    firstName: "Pooja", lastName: "Mehta", company: "Mehta Polymers", phoneNo: 8,
    scenario: "Thin website lead: company + industry only",
    website: { message: "Industry: Plastic Moulding" },
  },
  // 2 non-engineering B2B.
  {
    firstName: "Karthik", lastName: "Iyer", company: "Brightcode Technologies", phoneNo: 9,
    scenario: "Non-engineering B2B: IT services company targeting US clients",
    website: { message: form("We are a 60-person software services company in Chennai. We want to win mid-size clients in the US for custom development and QA.", "IT Services", "₹10–50 Cr") },
  },
  {
    firstName: "Neha", lastName: "Joshi", company: "Joshi & Associates Chartered Accountants", phoneNo: 10,
    scenario: "Non-engineering B2B: CA / consulting firm wanting more corporate clients",
    lead: { source: "linkedin", industry: "Accounting & Consulting", jobTitle: "Partner", revenueRange: "₹1–5 Cr" },
    steps: [{ note: "Connected on LinkedIn. CA firm in Ahmedabad, mostly individual and small business clients. Wants more corporate clients for audit and GST advisory." }],
  },
  // 1 consumer business: the AI should stop or hand off, never pitch.
  {
    firstName: "Farah", lastName: "Khan", company: "Sweet Crumbs Bakery", phoneNo: 11,
    scenario: "Consumer business: bakery wanting more walk-in customers (should stop/hand off)",
    website: { message: form("We run a bakery and cafe in Bandra. We want more walk-in customers on weekdays.", "Bakery / Food & Beverage", "Below ₹1 Cr") },
  },
  // 3 after a rep call.
  {
    firstName: "Vikram", lastName: "Deshpande", company: "Deshpande Castings Pvt Ltd", phoneNo: 12,
    scenario: "After call: asked to call after Diwali (timing)",
    website: { message: form("Foundry for grey and SG iron castings. Want new customers in pump and valve industry.", "Foundry / Castings", "₹10–50 Cr") },
    steps: [{
      call: {
        connected: true, connectedOutcome: "interested_later",
        notes: "Spoke to Vikram. Interested but busy with festive season dispatches. Asked to call after Diwali.",
        interestedLater: { reason: "Busy until after Diwali", restartAt: "2026-11-16" },
      },
    }],
  },
  {
    firstName: "Anil", lastName: "Reddy", company: "Reddy Engineering Solutions", phoneNo: 13,
    scenario: "After call: already has a sales team of 5, sceptical (objection)",
    lead: { source: "cold_call", industry: "Material Handling Equipment", jobTitle: "Managing Director", revenueRange: "₹10–50 Cr" },
    steps: [{
      call: {
        connected: true, connectedOutcome: "existing_team",
        notes: "Anil says they already have a sales team of 5 people. Sceptical that outside help will add anything. Did not refuse a follow-up.",
      },
    }],
  },
  {
    firstName: "Sanjay", lastName: "Gupta", company: "Gupta Packaging Industries", phoneNo: 14,
    scenario: "After call: interested, wants the process, asked for a call on Monday (ready → handoff)",
    lead: { source: "referral", industry: "Corrugated Packaging", jobTitle: "Director", revenueRange: "₹10–50 Cr" },
    steps: [{
      call: {
        connected: true, connectedOutcome: "callback_requested", callbackDueAt: nextMondayIst(),
        notes: "Sanjay is interested. Wants to understand how the process works and what we need from them. Asked for a call on Monday.",
      },
    }],
  },
  // 2 objections in notes.
  {
    firstName: "Deepak", lastName: "Malhotra", company: "Malhotra Electricals", phoneNo: 15,
    scenario: "Objection note: tried two agencies before, poor results",
    lead: { source: "linkedin", industry: "Electrical Panels", jobTitle: "Owner", revenueRange: "₹5–10 Cr" },
    steps: [{ note: "Deepak said they tried two agencies before for lead generation. Poor results, mostly irrelevant enquiries. Wary of trying again." }],
  },
  {
    firstName: "Ritu", lastName: "Bansal", company: "Bansal Fasteners Pvt Ltd", phoneNo: 16,
    scenario: "Objection note: asked whether we guarantee orders",
    lead: { source: "event", industry: "Industrial Fasteners", jobTitle: "CEO", revenueRange: "₹10–50 Cr" },
    steps: [{ note: "Met Ritu at the engineering expo. She asked: will you guarantee orders?" }],
  },
  // 1 asked about price.
  {
    firstName: "Manoj", lastName: "Tiwari", company: "Tiwari Conveyors", phoneNo: 17,
    scenario: "Price question in a note (→ handoff)",
    lead: { source: "email", industry: "Conveyor Systems", jobTitle: "Proprietor", revenueRange: "₹5–10 Cr" },
    steps: [{ note: "Manoj replied to our email asking: what are your charges?" }],
  },
  // 1 Pune company asking for a visit.
  {
    firstName: "Swati", lastName: "Pawar", company: "Pawar Precision Tools", phoneNo: 18,
    scenario: "Pune company asking whether someone can visit (→ handoff, never promise)",
    lead: { source: "cold_call", industry: "Cutting Tools", jobTitle: "Founder", revenueRange: "₹5–10 Cr" },
    steps: [{ note: "Swati's company is in Bhosari MIDC, Pune. She asked whether someone from our team can visit their factory to understand the business." }],
  },
  // 1 meeting completed, follow-up required.
  {
    firstName: "Rohit", lastName: "Saxena", company: "Saxena Industrial Valves", phoneNo: 19,
    scenario: "Meeting completed: outcome follow-up required, deal at Meeting follow-up",
    lead: { source: "referral", industry: "Industrial Valves", jobTitle: "Managing Director", revenueRange: "₹10–50 Cr" },
    createdDaysAgo: 12,
    steps: [
      {
        daysAgo: 4,
        meeting: {
          title: "Discovery call - Saxena Industrial Valves", atDaysAgo: 4, outcome: "follow_up_required",
          notes: "Good discussion. They supply gate and globe valves to refineries. Rohit wants to discuss with his brother (co-director) before next steps. Follow up next week.",
        },
      },
    ],
  },
  // 1 proposal sent 5 days ago, no reply since.
  {
    firstName: "Priya", lastName: "Nair", company: "Nair Thermal Systems", phoneNo: 20,
    scenario: "Proposal sent 5 days ago, deal at Proposal sent, no reply since",
    lead: { source: "website", industry: "Industrial Heat Exchangers", jobTitle: "Director", revenueRange: "₹10–50 Cr" },
    createdDaysAgo: 20,
    steps: [
      {
        daysAgo: 14,
        meeting: {
          title: "Discovery meeting - Nair Thermal Systems", atDaysAgo: 14, outcome: "proposal_required",
          notes: "Priya wants new customers in pharma and chemical plants for their shell-and-tube heat exchangers. Asked for a proposal.",
        },
      },
      { daysAgo: 5, proposal: { title: "Business development proposal - Nair Thermal Systems", amount: 180000, sentDaysAgo: 5 } },
    ],
  },
];

async function main() {
  await import("dotenv/config");
  assertStagingDatabase(process.env.DATABASE_URL?.trim());
  const confirm = process.argv.includes("--confirm");
  const remove = process.argv.includes("--remove");
  const repair = process.argv.includes("--repair");

  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool, withTransaction } = await import("../src/db.js");
  const { ingestWebsiteLead } = await import("../src/services/leadIngest.service.js");
  const { createLead, updateLead, addNote, deleteLead } = await import("../src/services/leads.service.js");
  const { logCall } = await import("../src/services/calls.service.js");
  const { scheduleMeeting, recordMeetingOutcome } = await import("../src/services/meetings.service.js");
  const { createProposal, updateProposalStatus } = await import("../src/services/proposals.service.js");
  const { cancelRunsForLead } = await import("../src/services/runs.service.js");
  const { enrollLeads } = await import("../src/services/agentStatus.service.js");
  const { linkCompanyForLead } = await import("../src/services/companies.service.js");
  const { normalizeCompanyName } = await import("../src/domain/companyNormalize.js");
  const { SIMILAR_NAME_THRESHOLD } = await import("../src/domain/companyMatch.js");
  const { cancelPendingWakeups, enqueueWakeups } = await import("../src/services/agentWakeups.service.js");
  type Actor = import("../src/authMiddleware.js").Actor;
  type Db = import("pg").PoolClient;
  const ws = MOTM_WORKSPACE_ID;

  const seededLeads = async () =>
    (
      await pool.query<{ id: string; email: string | null; phone_e164: string | null }>(
        `select id, email, phone_e164 from public.leads
          where workspace_id = $1 and created_by_name = $2 and (email = any($3::text[]) or phone_e164 = any($4::text[]))`,
        [ws, SEED_MARKER, SCENARIOS.map(seedEmail).filter(Boolean), SCENARIOS.map((s) => normalizePhoneE164(seedPhone(s)))],
      )
    ).rows;

  const seeded = new Set<string>([...SCENARIOS.map(seedEmail).filter((e): e is string => Boolean(e)), ...SCENARIOS.map((x) => normalizePhoneE164(seedPhone(x)) ?? "")]);
  seeded.delete("");

  try {
    const owner = (
      await pool.query<{ id: string; full_name: string; email: string; role: Actor["role"] }>(
        `select id, full_name, email, role from public.profiles
          where is_active and (full_name = 'Naitik' or (role = 'admin' and full_name ilike 'demo'))
          order by (full_name = 'Naitik') desc limit 1`,
      )
    ).rows[0];
    if (!owner) throw new Error("No active staging user 'Naitik' (or the demo admin) to own the contacts.");
    const actor: Actor = { id: owner.id, fullName: owner.full_name, email: owner.email, isActive: true, role: owner.role };
    const settings = (
      await pool.query<{ mode: string; max_decisions_per_day: number }>(
        `select mode, max_decisions_per_day from public.agent_settings where workspace_id = $1`,
        [ws],
      )
    ).rows[0];
    console.log(`Workspace MOTM · AI mode ${settings?.mode} · daily decision cap ${settings?.max_decisions_per_day} · owner ${actor.fullName}`);

    if (remove) {
      const rows = await seededLeads();
      console.log(`Seeded contacts to delete permanently: ${rows.length}`);
      if (!confirm) return console.log("Dry run: nothing changed. Re-run with -- --confirm to delete them.");
      for (const row of rows) await withTransaction((db) => deleteLead(db, actor, ws, row.id));
      return console.log(`Deleted ${rows.length} contact(s).`);
    }

    if (repair) {
      const rows = (
        await pool.query<{ id: string; email: string | null; phone_e164: string | null; name: string; company: string; linked: string | null }>(
          `select l.id, l.email, l.phone_e164, l.first_name || ' ' || l.last_name as name, l.company, c.name as linked
             from public.leads l left join public.companies c on c.id = l.company_id
            where l.workspace_id = $1 and l.created_by_name = $2 order by l.created_at`,
          [ws, SEED_MARKER],
        )
      ).rows.filter((r) => seeded.has(r.email ?? "") || seeded.has(r.phone_e164 ?? ""));
      console.log(`Seeded contacts: ${rows.length}`);
      for (const row of rows) {
        const s = SCENARIOS.find((x) => seedEmail(x) === row.email || normalizePhoneE164(seedPhone(x)) === row.phone_e164)!;
        const intended = seedCompany(s);
        // A blank form company was stored as a placeholder ("Not provided"): nothing to restore.
        if (!intended || row.company === intended) {
          console.log(`ok      ${row.name} · ${row.company} (linked: ${row.linked ?? "none"})`);
          if (!confirm || !intended) continue;
        } else {
          console.log(`${confirm ? "repair" : "would repair"}  ${row.name} · "${row.company}" → "${intended}" (linked: ${row.linked ?? "none"})`);
          if (!confirm) continue;
        }
        const after = await withTransaction(async (db: Db) => {
          await db.query(`update public.leads set company = $2 where id = $1`, [row.id, intended]);
          // The bug's contact-level suggestions ("Says <name>" next to the wrong company) are stale now.
          await db.query(
            `update public.company_duplicate_candidates set status = 'dismissed', resolved_by = $2, resolved_at = now()
              where lead_id = $1 and company_b_id is null and status = 'open'`,
            [row.id, actor.id],
          );
          await linkCompanyForLead(db, ws, row.id);
          // The meeting/proposal scenarios' deals took the wrong company too.
          await db.query(`update public.deals set company_id = (select company_id from public.leads where id = $1) where lead_id = $1`, [row.id]);
          return (
            await db.query<{ company: string; linked: string | null }>(
              `select l.company, c.name as linked from public.leads l left join public.companies c on c.id = l.company_id where l.id = $1`,
              [row.id],
            )
          ).rows[0]!;
        });
        console.log(`   after: ${after.company} (linked: ${after.linked ?? "none"})`);
      }

      // List only: other contacts whose submitted company name lost to a domain match (their contact-level rows keep it).
      const others = (
        await pool.query<{ workspace: string; lead_id: string; name: string; observed: string; company: string; normalized: string; status: string }>(
          `select w.name as workspace, d.lead_id, l.first_name || ' ' || l.last_name as name, d.observed_name as observed,
                  c.name as company, c.normalized_name as normalized, d.status
             from public.company_duplicate_candidates d
             join public.leads l on l.id = d.lead_id
             join public.companies c on c.id = d.company_a_id
             join public.workspaces w on w.id = d.workspace_id
            where d.reason = 'same_domain_different_name' and d.company_b_id is null
              and l.created_by_name is distinct from $1 and w.name not like '[test]%'`,
          [SEED_MARKER],
        )
      ).rows;
      const scored = await Promise.all(
        others.map(async (o) => ({
          ...o,
          similarity: (await pool.query<{ s: number }>(`select extensions.similarity($1, $2)::float8 as s`, [normalizeCompanyName(o.observed), o.normalized])).rows[0]!.s,
        })),
      );
      const differentName = scored.filter((o) => o.similarity < SIMILAR_NAME_THRESHOLD);
      console.log(`\nNon-seeded contacts linked by domain to a differently named company (similarity < ${SIMILAR_NAME_THRESHOLD}): ${differentName.length}`);
      for (const o of differentName) console.log(`  ${o.workspace} · ${o.name} (${o.lead_id}) said "${o.observed}", linked to "${o.company}" · row ${o.status}`);
      if (!confirm) console.log("\nDry run: nothing changed. Re-run with -- --confirm to repair the seeded contacts.");
      return;
    }

    const table: { name: string; company: string; scenario: string; leadId: string }[] = [];
    const created: string[] = [];
    for (const s of SCENARIOS) {
      const email = seedEmail(s);
      const phoneE164 = normalizePhoneE164(seedPhone(s));
      const name = `${s.firstName} ${s.lastName}`;
      const existing = (
        await pool.query<{ id: string }>(
          `select id from public.leads where workspace_id = $1 and (email = $2 or phone_e164 = $3) limit 1`,
          [ws, email, phoneE164],
        )
      ).rows[0];
      if (existing) {
        console.log(`skip  ${name} (exists ${existing.id})`);
        table.push({ name, company: s.company, scenario: s.scenario, leadId: existing.id });
        continue;
      }
      if (!confirm) {
        console.log(`would create  ${name} · ${s.company || "(no company)"} · ${s.website ? "website form" : s.lead?.source} · ${s.steps?.length ?? 0} step(s)`);
        table.push({ name, company: s.company, scenario: s.scenario, leadId: "(dry run)" });
        continue;
      }

      const leadId = await withTransaction(async (db: Db) => {
        let id: string;
        const timelineIds = async () => (await db.query<{ id: string }>(`select id from public.timeline_events where lead_id = $1`, [id])).rows.map((r) => r.id);
        const backdate: { ids: string[]; daysAgo: number }[] = [];
        if (s.website) {
          const outcome = await ingestWebsiteLead(db, ws, {
            name,
            email,
            phone: seedPhone(s),
            company: s.website.company ?? s.company,
            message: s.website.message,
          });
          if (outcome.status !== "created") throw new Error(`${name}: website ingest ${outcome.status}`);
          id = outcome.leadId;
          await updateLead(db, actor, ws, id, { ownerId: actor.id });
        } else {
          id = (
            await createLead(db, actor, ws, {
              firstName: s.firstName,
              lastName: s.lastName,
              company: s.company,
              email: email ?? undefined,
              phone: seedPhone(s),
              source: s.lead?.source ?? "other",
              industry: s.lead?.industry,
              jobTitle: s.lead?.jobTitle,
              revenueRange: s.lead?.revenueRange,
              ownerId: actor.id,
            })
          ).id;
        }
        await db.query(`update public.leads set created_by_name = $2 where id = $1`, [id, SEED_MARKER]);
        let seen = await timelineIds();
        if (s.createdDaysAgo) backdate.push({ ids: seen, daysAgo: s.createdDaysAgo });

        const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
        for (const step of s.steps ?? []) {
          if ("call" in step) await logCall(db, actor, ws, id, step.call);
          else if ("note" in step) await addNote(db, actor, ws, id, step.note);
          else if ("meeting" in step) {
            const meeting = await scheduleMeeting(db, actor, ws, { leadId: id, title: step.meeting.title, at: daysAgo(step.meeting.atDaysAgo), durationMin: 45 });
            await recordMeetingOutcome(db, actor, ws, meeting.id, step.meeting.outcome, step.meeting.notes);
          } else {
            const proposal = await createProposal(db, actor, ws, { leadId: id, title: step.proposal.title, amount: step.proposal.amount });
            await updateProposalStatus(db, actor, ws, proposal.id, "sent");
            // updateProposalStatus stamps now(); the scenario needs the send in the past.
            await db.query(
              `update public.proposals set sent_at = now() - make_interval(days => $2), follow_up_at = now() - make_interval(days => $2 - 3) where id = $1`,
              [proposal.id, step.proposal.sentDaysAgo],
            );
          }
          const after = await timelineIds();
          if (step.daysAgo) backdate.push({ ids: after.filter((t) => !seen.includes(t)), daysAgo: step.daysAgo });
          seen = after;
        }
        // Backdating only moves the timeline rows (and last activity) of this new contact; nothing else is touched.
        for (const b of backdate) {
          await db.query(`update public.timeline_events set occurred_at = occurred_at - make_interval(days => $2) where id = any($1::uuid[])`, [b.ids, b.daysAgo]);
        }
        if (backdate.length) {
          await db.query(`update public.leads set last_activity_at = (select max(occurred_at) from public.timeline_events where lead_id = $1) where id = $1`, [id]);
        }
        // Safety net: a seeded contact is never in a workflow (MOTM has no auto-trigger workflow today).
        await cancelRunsForLead(db, id, "AI test seed contact");
        return id;
      });
      created.push(leadId);
      console.log(`created  ${name} → ${leadId}`);
      table.push({ name, company: s.company, scenario: s.scenario, leadId });
    }

    if (confirm) {
      const ids = (await seededLeads()).map((r) => r.id);
      const enrolled = await enrollLeads(pool, actor, ws, ids);
      const counts = enrolled.reduce<Record<string, number>>((acc, r) => {
        const key = r.result === "skipped" ? `skipped:${r.reason}` : r.result;
        return { ...acc, [key]: (acc[key] ?? 0) + 1 };
      }, {});
      console.log(`AI enrolment: ${JSON.stringify(counts)}`);
      const newlyEnrolled = enrolled.filter((r) => r.result === "enrolled").map((r) => r.leadId);
      if (settings?.mode === "off") {
        console.log("AI mode is off: no wake-ups queued now. Switching to Shadow wakes every active AI contact over 60 minutes.");
      } else if (newlyEnrolled.length) {
        // Enrolment queued a wake-up due now; replace it with one spread over the next 2 hours.
        const now = Date.now();
        for (const leadId of newlyEnrolled) await cancelPendingWakeups(pool, leadId, "AI test seed: first wake-up spread over 2 hours");
        const items = newlyEnrolled.map((leadId, i) => ({ leadId, dueAt: new Date(now + Math.round((WAKE_SPREAD_MS * i) / newlyEnrolled.length)) }));
        const outcomes = await enqueueWakeups(pool, ws, items, "enrolled");
        console.log(`Wake-ups queued over 2 h: ${outcomes.filter((o) => o !== "skipped").length}`);
      }
      const active = (await pool.query<{ n: number }>(`select count(*)::int as n from public.leads where workspace_id = $1 and agent_status = 'active'`, [ws])).rows[0]!.n;
      console.log(`AI-active contacts in MOTM: ${active} (daily decision cap ${settings?.max_decisions_per_day})`);
    }

    const md = [
      `# AI test contacts (staging, MOTM)`,
      ``,
      `Generated ${new Date().toISOString()} by \`npm run staging:seed-ai-test-contacts\`${confirm ? "" : " (dry run)"}. Remove with \`npm.cmd run staging:remove-ai-test-contacts -- --confirm\`.`,
      ``,
      `| # | Name | Company | Scenario | Lead id |`,
      `|---|---|---|---|---|`,
      ...table.map((r, i) => `| ${i + 1} | ${r.name} | ${r.company || "—"} | ${r.scenario} | ${r.leadId} |`),
    ].join("\n");
    console.log(`\n${md}\n`);
    if (confirm) {
      const out = join(dirname(fileURLToPath(import.meta.url)), "output", "ai-test-contacts.md");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${md}\n`);
      console.log(`Written to ${out}`);
    } else {
      console.log("Dry run: nothing changed. Re-run with -- --confirm to create them.");
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
