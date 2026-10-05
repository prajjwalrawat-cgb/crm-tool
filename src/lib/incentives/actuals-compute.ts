import 'server-only';

import { sql } from 'drizzle-orm';

import type { IncentivePlanRow } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { fiscalYearRange } from '@/lib/targets/fiscal';
import { splitPortionInWindowSql, toISODate } from '@/lib/targets/fy-attribution';
import { QUOTA_CREDIT_SQL, QUOTA_WITHHELD_SQL } from '@/lib/targets/quota-credit';

import { upsertComputedActuals } from './mutations';
import { Rational } from './rational';

/**
 * COMPUTED ACTUALS — the three engine inputs, derived from deal data.
 *
 * Nothing here is new revenue logic; it reuses the rules Targets already
 * applies, so a SPOC's incentive and their target attainment can't count the
 * same deal differently:
 *
 *   * WHICH deals: won, not deleted, owned by the plan's resource, earning
 *     quota credit (`QUOTA_CREDIT_SQL` — approval 'none' or 'approved'), and
 *     weighted by `quota_weight` (the 4+-pushes haircut).
 *   * HOW MUCH lands in the FY: `deal_value_splits` prorated by date overlap
 *     (`splitPortionInWindowSql`). A deal with no breakdown is single-year —
 *     all of it in the FY it closed in — exactly as Targets assumes.
 *
 * PRIOR-YEAR vs NET-NEW is not a tag anyone has to set: it is the deal's
 * `closed_at` against the FY start. Closed before → carry-forward revenue
 * recognised this year; closed inside → net-new.
 *
 * WHAT IS EXCLUDED, AND SAID OUT LOUD (never silently in or out):
 *   * won deals with no `closed_at` — can't be classified, so not counted;
 *   * deals not in INR — the plan is denominated in ₹ Cr and there is no FX
 *     table to convert with;
 *   * deals with no `margin_bps` — their REVENUE counts (it is real revenue),
 *     but they are left out of the blended margin rather than entered at 0%,
 *     which would trigger a margin cut the SPOC didn't earn. How much revenue
 *     that leaves out of the margin base is reported.
 *   * won deals pending approval — not credited, as in Targets.
 */

export type ComputedActualsDetails = {
  fiscalYear: number;
  window: { start: string; end: string };
  countedDeals: number;
  /** Counted deals with no value breakdown (single-year assumption). */
  splitlessDeals: number;
  untaggedDeals: number;
  untaggedRevenueCr: string;
  nonInrDeals: number;
  marginUnknownDeals: number;
  marginUnknownRevenueCr: string;
  /** Revenue the blended margin was computed over. */
  marginBaseRevenueCr: string;
  pendingApprovalDeals: number;
};

type Row = {
  prior_minor: string | null;
  net_new_minor: string | null;
  margin_weighted_minor: string | null;
  margin_base_minor: string | null;
  counted: number | string;
  splitless: number | string;
  untagged: number | string;
  untagged_minor: string | null;
  non_inr: number | string;
  margin_unknown: number | string;
  margin_unknown_minor: string | null;
  pending: number | string;
};

const PAISE_PER_CRORE = Rational.parse('1000000000');

function minorToCr(v: string | null): Rational {
  return Rational.parse(v ?? '0').div(PAISE_PER_CRORE);
}

export type ComputedActuals = {
  priorYearRevenueCr: string;
  netNewRevenueCr: string;
  blendedMarginPct: string;
  details: ComputedActualsDetails;
};

/** Pure computation — reads deals, writes nothing. */
export async function computeActuals(
  tenantId: string,
  userId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<ComputedActuals> {
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  const fyStartISO = toISODate(start);
  const fyEndISO = toISODate(end);
  const credited = sql.raw(QUOTA_CREDIT_SQL);
  const withheld = sql.raw(QUOTA_WITHHELD_SQL);

  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      WITH won AS (
        SELECT
          id, amount_minor, quota_weight, margin_bps, closed_at,
          upper(currency) = 'INR' AS is_inr,
          (${credited}) AS credited,
          (${withheld}) AS withheld
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND owner_id = ${userId}
          AND stage = 'won'
          AND deleted_at IS NULL
          AND (closed_at IS NULL OR closed_at < ${end.toISOString()}::timestamptz)
      ),
      attributed AS (
        SELECT
          w.*,
          sp.has_split,
          (w.closed_at IS NOT NULL) AS tagged,
          (w.closed_at < ${start.toISOString()}::timestamptz) AS is_prior,
          (CASE
             WHEN sp.has_split THEN sp.in_fy
             WHEN w.closed_at >= ${start.toISOString()}::timestamptz THEN w.amount_minor::numeric
             ELSE 0::numeric
           END) * w.quota_weight AS in_fy
        FROM won w
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) > 0 AS has_split,
            ${splitPortionInWindowSql(fyStartISO, fyEndISO)} AS in_fy
          FROM deal_value_splits s
          WHERE s.deal_id = w.id
        ) sp ON TRUE
      )
      SELECT
        SUM(in_fy) FILTER (WHERE credited AND tagged AND is_inr AND is_prior)::text AS prior_minor,
        SUM(in_fy) FILTER (WHERE credited AND tagged AND is_inr AND NOT is_prior)::text AS net_new_minor,
        SUM(in_fy * margin_bps / 10000)
          FILTER (WHERE credited AND tagged AND is_inr AND margin_bps IS NOT NULL)::text AS margin_weighted_minor,
        SUM(in_fy)
          FILTER (WHERE credited AND tagged AND is_inr AND margin_bps IS NOT NULL)::text AS margin_base_minor,
        COUNT(*) FILTER (WHERE credited AND tagged AND is_inr AND in_fy > 0)::int AS counted,
        COUNT(*) FILTER (WHERE credited AND tagged AND is_inr AND in_fy > 0 AND NOT has_split)::int AS splitless,
        COUNT(*) FILTER (WHERE credited AND NOT tagged)::int AS untagged,
        SUM(amount_minor) FILTER (WHERE credited AND NOT tagged)::text AS untagged_minor,
        COUNT(*) FILTER (WHERE credited AND tagged AND NOT is_inr AND in_fy > 0)::int AS non_inr,
        COUNT(*) FILTER (WHERE credited AND tagged AND is_inr AND in_fy > 0 AND margin_bps IS NULL)::int
          AS margin_unknown,
        SUM(in_fy) FILTER (WHERE credited AND tagged AND is_inr AND margin_bps IS NULL)::text
          AS margin_unknown_minor,
        COUNT(*) FILTER (WHERE withheld AND (in_fy > 0 OR NOT tagged))::int AS pending
      FROM attributed
    `),
  )) as unknown as Row[];

  const r = rows[0];
  const prior = minorToCr(r?.prior_minor ?? null);
  const netNew = minorToCr(r?.net_new_minor ?? null);
  const marginBase = Rational.parse(r?.margin_base_minor ?? '0');
  let margin = marginBase.isZero()
    ? Rational.ZERO
    : Rational.parse(r?.margin_weighted_minor ?? '0').div(marginBase);
  // margin_bps is unconstrained in the deals table; keep the stored figure
  // inside the range the engine and the CHECK accept.
  margin = Rational.min(Rational.ONE, Rational.max(Rational.ZERO, margin));

  return {
    priorYearRevenueCr: prior.toFixed(7),
    netNewRevenueCr: netNew.toFixed(7),
    blendedMarginPct: margin.toFixed(6),
    details: {
      fiscalYear,
      window: { start: fyStartISO, end: fyEndISO },
      countedDeals: Number(r?.counted ?? 0),
      splitlessDeals: Number(r?.splitless ?? 0),
      untaggedDeals: Number(r?.untagged ?? 0),
      untaggedRevenueCr: minorToCr(r?.untagged_minor ?? null).toFixed(7),
      nonInrDeals: Number(r?.non_inr ?? 0),
      marginUnknownDeals: Number(r?.margin_unknown ?? 0),
      marginUnknownRevenueCr: minorToCr(r?.margin_unknown_minor ?? null).toFixed(7),
      marginBaseRevenueCr: minorToCr(r?.margin_base_minor ?? null).toFixed(7),
      pendingApprovalDeals: Number(r?.pending ?? 0),
    },
  };
}

/** Compute and store today's figure for one plan. Idempotent per day. */
export async function recomputePlanActuals(
  tenantId: string,
  plan: Pick<IncentivePlanRow, 'id' | 'userId' | 'fiscalYear'>,
  startMonth: number,
  now: Date,
): Promise<ComputedActuals> {
  const computed = await computeActuals(tenantId, plan.userId, plan.fiscalYear, startMonth);
  await upsertComputedActuals({
    tenantId,
    planId: plan.id,
    asOfDate: toISODate(now),
    priorYearRevenueCr: computed.priorYearRevenueCr,
    netNewRevenueCr: computed.netNewRevenueCr,
    blendedMarginPct: computed.blendedMarginPct,
    details: computed.details,
  });
  return computed;
}
