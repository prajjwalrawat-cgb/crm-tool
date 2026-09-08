import 'server-only';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  type Company,
  companies,
  contacts,
  deals,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import type { DealStage } from '@/lib/deals/schema';
import { timeQuery } from '@/lib/pagination/timing';
import {
  getAccountTimeline,
  type TimelineItem,
} from '@/lib/timeline/queries';

/**
 * Account 360 — one aggregate read behind the company detail view.
 *
 * The gap this closes: the detail page used to be a company record with
 * a comment thread bolted on. It could not answer "who do we know here,
 * what are we selling them, and what happened last" without three
 * separate trips to three separate list views.
 *
 * The rollups are capped HERE, in SQL, not trimmed in the component.
 * The card shows five contacts and a header count; fetching every
 * contact on the account to render five of them would make the page
 * cost scale with the size of the account, which is exactly backwards —
 * the biggest accounts are the ones people open most.
 *
 * `total` therefore comes from its own `COUNT(*)`, not from
 * `rows.length`: the two disagree by design as soon as an account has
 * more than five of anything, and the header count is the honest number.
 */

/** Rows shown inside a rollup card before "View All" takes over. */
export const ACCOUNT_ROLLUP_LIMIT = 5;

/** Items pulled into the account-wide activity feed. */
export const ACCOUNT_TIMELINE_LIMIT = 150;

export type AccountContactSummary = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  updatedAt: Date;
};

export type AccountDealSummary = {
  id: string;
  name: string;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  expectedCloseDate: string | null;
  updatedAt: Date;
};

export type AccountRollup<T> = {
  /** Up to `ACCOUNT_ROLLUP_LIMIT` rows, already ordered for display. */
  rows: T[];
  /** Every row that matches, not just the ones returned. Drives the header. */
  total: number;
};

export type Account360 = {
  company: Company;
  contacts: AccountRollup<AccountContactSummary>;
  deals: AccountRollup<AccountDealSummary>;
  /** Company + every deal + every contact under it, newest first. */
  timeline: TimelineItem[];
};

/**
 * Everything the Account 360 view renders, in one call.
 *
 * Returns `null` when the id does not resolve inside the caller's
 * tenant — the company lookup runs first so a foreign id 404s rather
 * than returning empty rollups, which would confirm the id exists.
 *
 * Must be called inside a tenant context (`withTenantSession` /
 * `runWithTenantContext`); every query below runs under RLS.
 */
export async function getAccount360(
  tenantId: string,
  companyId: string,
  options: { rollupLimit?: number; timelineLimit?: number } = {},
): Promise<Account360 | null> {
  const rollupLimit = options.rollupLimit ?? ACCOUNT_ROLLUP_LIMIT;
  const timelineLimit = options.timelineLimit ?? ACCOUNT_TIMELINE_LIMIT;

  return await timeQuery('companies.account360', async () => {
    // Two transactions, not six. Every RLS-scoped transaction costs four
    // round trips to Postgres (BEGIN + app_set_ctx + query + COMMIT), so
    // the company row and both rollups share one, and the timeline —
    // which owns its own — runs beside it. Firing one transaction per
    // query would have made "one aggregating call" true only of the
    // browser and false of the database, which is the more expensive
    // half (see hover-prefetch-link.tsx for how that bill arrives).
    const [core, timeline] = await Promise.all([
      tenantTransaction(async (tx) => {
        const companyRows = await tx
          .select()
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, tenantId),
              eq(companies.id, companyId),
              isNull(companies.deletedAt),
              isNull(companies.mergedIntoId),
            ),
          )
          .limit(1);
        const company = companyRows[0];
        if (!company) return null;

        /**
         * `count(*) OVER ()` is evaluated over the whole filtered set
         * before LIMIT applies, so each rollup returns its five rows AND
         * the true total in one pass. The alternative — a second
         * COUNT(*) per rollup — doubles the queries to tell the header
         * something the same scan already knows, and lets the count
         * drift from the rows if the two ever stop sharing a predicate.
         */
        const total = sql<number>`count(*) over ()`.mapWith(Number);

        const [contactRows, dealRows] = await Promise.all([
          tx
            .select({
              id: contacts.id,
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              title: contacts.title,
              email: contacts.email,
              phone: contacts.phone,
              updatedAt: contacts.updatedAt,
              total,
            })
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.companyId, companyId),
                isNull(contacts.deletedAt),
                isNull(contacts.mergedIntoId),
              ),
            )
            .orderBy(desc(contacts.updatedAt))
            .limit(rollupLimit),

          // Won and lost deals stay in the rollup — an account's history
          // is part of its 360 — but the ordering keys off `updated_at`,
          // so what surfaces first is what someone actually touched last.
          tx
            .select({
              id: deals.id,
              name: deals.name,
              stage: deals.stage,
              amountMinor: deals.amountMinor,
              currency: deals.currency,
              expectedCloseDate: deals.expectedCloseDate,
              updatedAt: deals.updatedAt,
              total,
            })
            .from(deals)
            .where(
              and(
                eq(deals.tenantId, tenantId),
                eq(deals.companyId, companyId),
                isNull(deals.deletedAt),
              ),
            )
            .orderBy(desc(deals.updatedAt))
            .limit(rollupLimit),
        ]);

        return { company, contactRows, dealRows };
      }),
      getAccountTimeline(tenantId, companyId, { limit: timelineLimit }),
    ]);

    if (!core) return null;

    // No rows means no window to count over, so the total is 0 rather
    // than absent — `rows[0].total` only exists when a row does.
    const totalOf = (rows: Array<{ total: number }>): number =>
      rows[0]?.total ?? 0;

    // Mapped field by field rather than spread-and-strip, so the shape
    // each card receives is the shape declared above it and the window
    // count does not leak into the row type.
    return {
      company: core.company,
      contacts: {
        total: totalOf(core.contactRows),
        rows: core.contactRows.map((r) => ({
          id: r.id,
          firstName: r.firstName,
          lastName: r.lastName,
          title: r.title,
          email: r.email,
          phone: r.phone,
          updatedAt: r.updatedAt,
        })),
      },
      deals: {
        total: totalOf(core.dealRows),
        rows: core.dealRows.map((r) => ({
          id: r.id,
          name: r.name,
          stage: r.stage,
          amountMinor: r.amountMinor,
          currency: r.currency,
          expectedCloseDate: r.expectedCloseDate,
          updatedAt: r.updatedAt,
        })),
      },
      timeline,
    };
  });
}
