import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

// Type-only: erased at compile time, so it does not pull the module in
// ahead of the dynamic imports below (which run after dotenv has loaded).
import type { CompletenessDeal } from '../src/lib/deals/completeness';

config({ path: '.env.local' });
config();

/**
 * Self-test for the team scorecard (/dashboard/team-performance).
 *
 * Four things are worth testing here and they are not the rendering:
 *
 *   1. THE PURE RULES. Fiscal quarters must partition the fiscal year
 *      exactly (that property is the only reason quarterly figures can be
 *      claimed to sum to the annual one), the derived quarterly target
 *      split must not lose the division remainder, and field applicability
 *      must follow the stage rules that already exist — a Lead owes no
 *      margin and no close date, a Proposal owes both.
 *
 *   2. THE SQL AGREES WITH THE JS. `completenessByOwner` evaluates the
 *      field spec in Postgres; `scoreDeal` evaluates the same spec in JS.
 *      One rule written twice is exactly the setup that let the quota
 *      credit rule drift for months, so this runs both over the same rows
 *      and asserts they match per rep AND per field.
 *
 *   3. QUARTERS RECONCILE TO THE YEAR. Q1+Q2+Q3+Q4 must equal the
 *      `targetAchievement` figure the Targets page shows, or the two pages
 *      are telling a manager two different stories about one number.
 *
 *   4. THE PUSHBACK LEADERBOARD COUNTS WHAT THE LOG HOLDS. Totals from the
 *      grouped query are re-derived with a flat COUNT over
 *      `deal_date_changes`.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

/** Money comparisons tolerate sub-unit rounding drift, nothing more. */
function near(a: number, b: number, tolerance = 2): boolean {
  return Math.abs(a - b) <= tolerance;
}

type TenantRow = { id: string; name: string };

type RawDeal = {
  id: string;
  owner_id: string;
  stage: string;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  amount_minor: string | number | null;
  margin_bps: number | null;
  expected_close_date: string | null;
  deal_type: string | null;
  source: string | null;
  next_step: string | null;
  description: string | null;
  custom_fields: Record<string, unknown> | null;
  has_value_split: boolean;
};

async function main() {
  const {
    elapsedFraction,
    fiscalQuarters,
    pace,
    quarterIndexOf,
    splitAnnualTarget,
  } = await import('../src/lib/targets/quarters');
  const { fiscalYearRange } = await import('../src/lib/targets/fiscal');
  const {
    DEAL_FIELD_SPECS,
    completenessBand,
    fieldApplies,
    ratioOf,
    scoreDeal,
  } = await import('../src/lib/deals/completeness');
  const { activityBand, silenceNote, weekLabel, weeksIn } = await import(
    '../src/lib/team-analytics/engagement'
  );

  /* ---------- 1: the pure rules ---------- */

  // An April-start fiscal year: Q1 = Apr–Jun, Q4 = Jan–Mar of the next
  // calendar year. The quarters must tile the year with no gap and no
  // overlap — the property every "quarters sum to the year" claim rests on.
  const startMonth = 4;
  const fy = 2026;
  const quarters = fiscalQuarters(startMonth, fy);
  const { start: fyStart, end: fyEnd } = fiscalYearRange(startMonth, fy);
  check(
    'Q1 opens the fiscal year and Q4 closes it',
    quarters[0].start.getTime() === fyStart.getTime() &&
      quarters[3].end.getTime() === fyEnd.getTime(),
    `${quarters[0].start.toISOString()} … ${quarters[3].end.toISOString()}`,
  );
  check(
    'consecutive quarters meet exactly — no gap, no overlap',
    quarters.every(
      (q, i) => i === 0 || q.start.getTime() === quarters[i - 1].end.getTime(),
    ),
  );
  check(
    'the four quarters cover the whole year and nothing else',
    quarters.reduce(
      (days, q) => days + (q.end.getTime() - q.start.getTime()) / 86_400_000,
      0,
    ) ===
      (fyEnd.getTime() - fyStart.getTime()) / 86_400_000,
  );
  check(
    'a date lands in exactly one quarter',
    quarterIndexOf(startMonth, fy, new Date(Date.UTC(2026, 6, 15))) === 2 &&
      quarterIndexOf(startMonth, fy, new Date(Date.UTC(2027, 1, 1))) === 4 &&
      quarterIndexOf(startMonth, fy, new Date(Date.UTC(2025, 1, 1))) === null,
  );

  // The remainder has to go somewhere; dropping it would make four
  // quarterly targets add up to less than the annual one on screen.
  const split = splitAnnualTarget(40_000_003);
  check(
    'the derived quarterly split loses nothing to rounding',
    split.reduce((a, b) => a + b, 0) === 40_000_003,
    split.join(' + '),
  );

  /* ---------- pace ---------- */

  const halfway = new Date(
    fyStart.getTime() + (fyEnd.getTime() - fyStart.getTime()) / 2,
  );
  const onPace = pace({
    achievedMinor: 50_000_000,
    targetMinor: 100_000_000,
    fyStart,
    fyEnd,
    now: halfway,
  });
  check(
    'half the target at half the year reads as on pace',
    onPace.state === 'tracked' && onPace.status === 'on-track',
    onPace.state === 'tracked' ? onPace.status : onPace.state,
  );
  const behind = pace({
    achievedMinor: 20_000_000,
    targetMinor: 100_000_000,
    fyStart,
    fyEnd,
    now: halfway,
  });
  check(
    'a fifth of the target at half the year is at risk, not merely behind',
    behind.state === 'tracked' && behind.status === 'at-risk',
    behind.state === 'tracked' ? behind.status : behind.state,
  );
  check(
    'the remaining gap and the run-rate it implies are both reported',
    behind.state === 'tracked' &&
      behind.gapMinor === 80_000_000 &&
      behind.requiredPerMonthMinor != null &&
      behind.requiredPerMonthMinor > 0,
  );
  check(
    'no target means no pace verdict at all',
    pace({
      achievedMinor: 5_000,
      targetMinor: 0,
      fyStart,
      fyEnd,
      now: halfway,
    }).state === 'no-target',
  );
  check(
    'a year that has not started is its own state, not 0% behind',
    pace({
      achievedMinor: 0,
      targetMinor: 100,
      fyStart,
      fyEnd,
      now: new Date(fyStart.getTime() - 86_400_000),
    }).state === 'not-started',
  );
  check(
    'elapsed fraction clamps at both ends',
    elapsedFraction(fyStart, fyEnd, new Date(fyStart.getTime() - 1)) === 0 &&
      elapsedFraction(fyStart, fyEnd, new Date(fyEnd.getTime() + 1)) === 1,
  );

  /* ---------- completeness applicability ---------- */

  const marginSpec = DEAL_FIELD_SPECS.find((s) => s.key === 'margin')!;
  const closeSpec = DEAL_FIELD_SPECS.find((s) => s.key === 'close_date')!;
  const companySpec = DEAL_FIELD_SPECS.find((s) => s.key === 'company')!;
  check(
    'a Lead owes neither a margin nor a close date',
    !fieldApplies(marginSpec, 'lead') && !fieldApplies(closeSpec, 'lead'),
  );
  check(
    'margin becomes owed at Qualified, close date at Proposal',
    fieldApplies(marginSpec, 'qualified') &&
      !fieldApplies(closeSpec, 'qualified') &&
      fieldApplies(closeSpec, 'proposal'),
  );
  check(
    'a parked deal still owes the basics but nothing stage-specific',
    fieldApplies(companySpec, 'hold') && !fieldApplies(closeSpec, 'hold'),
  );

  const bareLead: CompletenessDeal = {
    stage: 'lead',
    companyId: null,
    companyNameText: '  ',
    contactId: null,
    contactNameText: null,
    contactEmailText: null,
    amountMinor: 0,
    marginBps: null,
    expectedCloseDate: null,
    dealType: null,
    source: null,
    nextStep: null,
    description: null,
    hasValueSplit: false,
    customFields: {},
  };
  const leadScore = scoreDeal(bareLead);
  check(
    'whitespace is not a filled field',
    leadScore.filled === 0,
    `${leadScore.filled} of ${leadScore.applicable}`,
  );
  check(
    'a Lead is scored only on what a Lead owes',
    leadScore.applicable ===
      DEAL_FIELD_SPECS.filter((s) => s.requiredFromRank <= 1).length,
    `${leadScore.applicable} applicable`,
  );
  const proposal = scoreDeal({ ...bareLead, stage: 'proposal' });
  check(
    'a Proposal is scored on strictly more fields than a Lead',
    proposal.applicable > leadScore.applicable,
    `${proposal.applicable} vs ${leadScore.applicable}`,
  );
  check(
    'a required custom field adds to the denominator',
    scoreDeal(bareLead, [{ key: 'po_number', label: 'PO number' }])
      .applicable ===
      leadScore.applicable + 1,
  );
  check(
    'a custom field holding only spaces is not filled',
    scoreDeal({ ...bareLead, customFields: { po_number: '   ' } }, [
      { key: 'po_number', label: 'PO number' },
    ]).filled === 0,
  );
  check(
    'nothing applicable scores as complete rather than dividing by zero',
    ratioOf(0, 0) === 1 && completenessBand(ratioOf(0, 0)) === 'good',
  );

  /* ---------- engagement helpers ---------- */

  check(
    'silence is a band, and "no deals" is not silence',
    activityBand(null) === null &&
      activityBand(1) === 'active' &&
      activityBand(4) === 'quiet' &&
      activityBand(30) === 'silent',
  );
  check(
    'a clean book produces no silence note',
    silenceNote(0, 12, null) === null &&
      (silenceNote(3, 12, 40) ?? '').includes('3 of 12'),
  );
  check(
    'a window shorter than a week still divides by one',
    weeksIn(new Date('2026-08-01'), new Date('2026-08-03')) === 1 &&
      weeksIn(new Date('2026-01-01'), new Date('2026-04-02')) === 13,
  );
  check(
    'a missing week renders as an em dash rather than "Invalid Date"',
    weekLabel(null) === '—' && weekLabel('nonsense') === '—',
  );

  /* ---------- 2–4: against real data ---------- */

  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { targetAchievement } = await import('../src/lib/targets/queries');
  const {
    completenessByOwner,
    engagementByOwner,
    pushbackLeaderboard,
    quarterlyAchievement,
    requiredDealCustomFields,
  } = await import('../src/lib/team-analytics/queries');

  const tenants = (await db.execute(
    sql`SELECT id, name FROM tenants ORDER BY name`,
  )) as unknown as TenantRow[];

  const now = new Date();
  const liveStartMonth = 1;
  const liveFy = now.getUTCFullYear();
  const { start: liveStart, end: liveEnd } = fiscalYearRange(
    liveStartMonth,
    liveFy,
  );
  const window = {
    from: liveStart,
    to: new Date(Math.min(liveEnd.getTime(), now.getTime())),
  };

  let comparedTenants = 0;
  let comparedOwners = 0;

  for (const t of tenants) {
    const customFields = await requiredDealCustomFields(t.id);

    const [completeness, quarterly, achievement, pushbacks, engagement] =
      await runWithSystemContext(t.id, async () =>
        Promise.all([
          completenessByOwner(t.id, customFields),
          quarterlyAchievement(t.id, liveFy, liveStartMonth),
          targetAchievement(t.id, liveFy, liveStartMonth),
          pushbackLeaderboard(t.id, window),
          engagementByOwner(t.id, window),
        ]),
      );

    if (
      completeness.length === 0 &&
      quarterly.length === 0 &&
      pushbacks.length === 0
    ) {
      continue;
    }
    comparedTenants++;

    /* --- 2: the completeness SQL agrees with the JS spec --- */

    const rawDeals = (await db.execute(sql`
      SELECT d.id, d.owner_id, d.stage::text AS stage,
             d.company_id, d.company_name, d.contact_id, d.contact_name,
             d.contact_email, d.amount_minor, d.margin_bps,
             d.expected_close_date::text AS expected_close_date,
             d.deal_type::text AS deal_type, d.source, d.next_step,
             d.description, d.custom_fields,
             EXISTS (
               SELECT 1 FROM deal_value_splits s WHERE s.deal_id = d.id
             ) AS has_value_split
      FROM deals d
      WHERE d.tenant_id = ${t.id}::uuid
        AND d.deleted_at IS NULL
        AND d.owner_id IS NOT NULL
        AND d.stage NOT IN ('won','lost')
    `)) as unknown as RawDeal[];

    const jsByOwner = new Map<
      string,
      { total: { applicable: number; filled: number }; byField: Map<string, { applicable: number; filled: number }>; deals: number }
    >();
    for (const raw of rawDeals) {
      const deal: CompletenessDeal = {
        stage: raw.stage,
        companyId: raw.company_id,
        companyNameText: raw.company_name,
        contactId: raw.contact_id,
        contactNameText: raw.contact_name,
        contactEmailText: raw.contact_email,
        amountMinor: raw.amount_minor == null ? null : Number(raw.amount_minor),
        marginBps: raw.margin_bps,
        expectedCloseDate: raw.expected_close_date,
        dealType: raw.deal_type,
        source: raw.source,
        nextStep: raw.next_step,
        description: raw.description,
        hasValueSplit: raw.has_value_split,
        customFields: raw.custom_fields ?? {},
      };
      const acc =
        jsByOwner.get(raw.owner_id) ??
        { total: { applicable: 0, filled: 0 }, byField: new Map(), deals: 0 };
      acc.deals += 1;
      const totals = scoreDeal(deal, customFields);
      acc.total.applicable += totals.applicable;
      acc.total.filled += totals.filled;
      for (const spec of DEAL_FIELD_SPECS) {
        if (!fieldApplies(spec, deal.stage)) continue;
        const cell = acc.byField.get(spec.key) ?? { applicable: 0, filled: 0 };
        cell.applicable += 1;
        if (spec.isFilled(deal)) cell.filled += 1;
        acc.byField.set(spec.key, cell);
      }
      jsByOwner.set(raw.owner_id, acc);
    }

    for (const row of completeness) {
      comparedOwners++;
      const js = jsByOwner.get(row.userId);
      const tag = `[${t.name}/${row.userId.slice(0, 12)}]`;
      check(
        `${tag} completeness SQL matches the JS field spec`,
        js != null &&
          js.total.applicable === row.total.applicable &&
          js.total.filled === row.total.filled,
        js
          ? `sql=${row.total.filled}/${row.total.applicable} js=${js.total.filled}/${js.total.applicable}`
          : 'no JS rows for this owner',
      );
      check(
        `${tag} the deal count behind the score matches`,
        js != null && js.deals === row.dealsScored,
        `sql=${row.dealsScored} js=${js?.deals}`,
      );
      // Per-field, not only in aggregate: two fields can disagree in
      // opposite directions and leave the total looking right.
      const mismatched = DEAL_FIELD_SPECS.filter((spec) => {
        const a = row.byField[spec.key] ?? { applicable: 0, filled: 0 };
        const b = js?.byField.get(spec.key) ?? { applicable: 0, filled: 0 };
        return a.applicable !== b.applicable || a.filled !== b.filled;
      }).map((s) => s.key);
      check(
        `${tag} every individual field agrees`,
        mismatched.length === 0,
        mismatched.join(', '),
      );
      check(
        `${tag} filled never exceeds applicable`,
        Object.values(row.byField).every((c) => c.filled <= c.applicable),
      );
    }

    /* --- 3: quarters reconcile to the year --- */

    const achByUser = new Map(achievement.map((a) => [a.userId, a]));
    for (const q of quarterly) {
      const ach = achByUser.get(q.userId);
      const sumQ = q.quarterRevenueMinor.reduce((a, b) => a + b, 0);
      const tag = `[${t.name}/${q.userId.slice(0, 12)}]`;
      // Rounding happens per deal per quarter here and per deal per year
      // there, so four roundings can differ from one by a minor unit per
      // deal. Anything larger is a real disagreement.
      const tolerance = (ach?.wonCount ?? 0) * 2 + 2;
      check(
        `${tag} Q1+Q2+Q3+Q4 reconciles to the annual attainment figure`,
        ach != null && near(sumQ, ach.fyRevenueMinor, tolerance),
        `quarters=${sumQ} annual=${ach?.fyRevenueMinor} tolerance=${tolerance}`,
      );
      check(
        `${tag} won deals are counted once across the four quarters`,
        ach != null &&
          q.quarterWonCount.reduce((a, b) => a + b, 0) === ach.wonCount,
        `quarters=${q.quarterWonCount.join('+')} annual=${ach?.wonCount}`,
      );
    }

    /* --- 4: the pushback leaderboard counts what the log holds --- */

    const flat = (await db.execute(sql`
      SELECT COUNT(*)::int AS pushes,
             COUNT(DISTINCT c.deal_id)::int AS deals,
             COALESCE(SUM(c.new_close_date - c.old_close_date), 0)::int AS days
      FROM deal_date_changes c
      JOIN deals d ON d.id = c.deal_id
      WHERE c.tenant_id = ${t.id}::uuid
        AND c.is_push
        AND c.changed_at >= ${window.from.toISOString()}::timestamptz
        AND c.changed_at <  ${window.to.toISOString()}::timestamptz
        AND d.deleted_at IS NULL
        AND d.owner_id IS NOT NULL
    `)) as unknown as Array<{ pushes: number; deals: number; days: number }>;

    const grouped = pushbacks.reduce(
      (acc, p) => ({
        pushes: acc.pushes + p.pushEvents,
        deals: acc.deals + p.dealsPushed,
        days: acc.days + p.daysPushed,
      }),
      { pushes: 0, deals: 0, days: 0 },
    );
    check(
      `[${t.name}] pushback totals match a flat count over the log`,
      grouped.pushes === Number(flat[0]?.pushes ?? 0) &&
        grouped.deals === Number(flat[0]?.deals ?? 0) &&
        grouped.days === Number(flat[0]?.days ?? 0),
      `grouped=${JSON.stringify(grouped)} flat=${JSON.stringify(flat[0])}`,
    );
    check(
      `[${t.name}] a push is never attributed to more deals than it touched`,
      pushbacks.every((p) => p.dealsPushed <= p.pushEvents || p.pushEvents === 0),
    );
    check(
      `[${t.name}] pushes made by others are a subset of all pushes`,
      pushbacks.every((p) => p.pushedByOthers <= p.pushEvents),
    );

    /* --- engagement sanity: stale is a subset of open --- */

    check(
      `[${t.name}] untouched open deals never exceed open deals`,
      engagement.every((e) => e.staleOpenDeals <= e.openDeals),
    );
    check(
      `[${t.name}] a rep's best week never exceeds what they created`,
      engagement.every((e) => e.bestWeekCount <= e.dealsCreated),
    );
  }

  check(
    'the SQL/JS comparison actually ran against data',
    comparedOwners > 0,
    `${comparedTenants} tenants, ${comparedOwners} owners compared`,
  );

  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed ` +
      `(${comparedTenants} tenants, ${comparedOwners} owners compared)`,
  );

  await client.end?.();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
