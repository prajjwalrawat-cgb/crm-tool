import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { fromMinorUnits } from '@/lib/deals/currency';
import { parseDealFilters } from '@/lib/deals/filters';
import { decodeCursor, type Cursor } from '@/lib/pagination/cursor';
import { listDeals, type DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import {
  OFFERING_CATEGORY_LABELS,
  primaryOfferingOf,
  UNCATEGORIZED_LABEL,
} from '@/lib/offerings/types';
import {
  componentDisplayName,
  rowsToElements,
  type SplitRow,
} from '@/lib/deals/value-split';
import { listDealValueSplitsFor } from '@/lib/deals/value-split-queries';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';
import {
  FORECAST_CATEGORY_LABELS,
  type ForecastCategory,
} from '@/lib/deals/forecast/categories';

import { resolveAuthorLookup } from '@/app/dashboard/_components/author-lookup';

// Cap the export so a runaway query can't stream unbounded rows.
const MAX_ROWS = 10_000;
const PAGE = 100;

/**
 * Export deals to a spreadsheet. Returns CSV (UTF-8 + BOM) which Excel opens
 * natively as a worksheet. Respects the current search + filters + persona scope
 * exactly like the list page (sales personas only get their own/unassigned).
 */
export async function GET(req: NextRequest) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }

  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const filters = parseDealFilters(raw);
  const search = url.searchParams.get('q')?.trim() || undefined;

  const { rows, splits } = await runWithTenantContext(
    { tenantId: orgId, userId },
    async () => {
      const membership = await requireMembership();
      const restrictToOwnerOrUnassigned =
        personaOf(membership.role) === 'sales' ? userId : undefined;

      // Page through the same query the list uses until exhausted or capped.
      const all: DealRow[] = [];
      let cursor: Cursor | null = null;
      for (let i = 0; i < MAX_ROWS / PAGE; i++) {
        const page = await listDeals(orgId, {
          search,
          filters,
          size: PAGE,
          cursor,
          currentUserId: userId,
          restrictToOwnerOrUnassigned,
        });
        all.push(...page.items);
        if (!page.nextCursor || all.length >= MAX_ROWS) break;
        cursor = decodeCursor(page.nextCursor);
        if (!cursor) break;
      }

      // Breakdowns for the whole page set in one query, not one per deal.
      const byDeal = await tenantTransaction((tx) =>
        listDealValueSplitsFor(
          tx,
          orgId,
          all.map((d) => d.id),
        ),
      );
      return { rows: all, splits: byDeal };
    },
  );

  // Resolve owner display names in one batch.
  const ownerIds = Array.from(
    new Set(rows.map((r) => r.ownerId).filter((v): v is string => !!v)),
  );
  const ownerNames = await resolveAuthorLookup(ownerIds);

  const csv = buildCsv(rows, ownerNames, splits);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="deals-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

const COLUMNS = [
  'Name',
  'Stage',
  'Amount',
  'Currency',
  'Company',
  'Contact',
  'Contact Email',
  // The PRIMARY offering, matching the list's Offering column — and
  // "Uncategorized" rather than a blank cell, so a spreadsheet filter can
  // isolate the untagged backlog the same way the list's chip does. `Offering
  // Count` is what stops the single name reading as the whole story on a
  // bundle deal.
  'Offering',
  'Offering Category',
  'Offering Count',
  'Owner',
  'Close Date',
  'Forecast Category',
  'Health Score',
  'Health Band',
  'Approval',
  'Next Step',
  'Competitor',
  'Source',
  'Created',
  'Updated',
] as const;

function buildCsv(
  rows: DealRow[],
  ownerNames: Record<string, string>,
  splits: Map<string, SplitRow[]>,
): string {
  // A breakdown is a grid of (element x year), so the number of stored rows is
  // a CELL count — the column width is the distinct YEAR count. Reading
  // `.length` here would over-count the years and, worse, `find`-ing one row
  // per year would silently export a single element's cell as the year total.
  const yearCount = (split: SplitRow[]) =>
    split.length === 0 ? 0 : new Set(split.map((s) => s.yearIndex)).size;

  // Multi-year columns are only as wide as the longest contract in this
  // export, so a workspace with no breakdowns gets the sheet it always got.
  const maxYears = rows.reduce(
    (max, r) => Math.max(max, yearCount(splits.get(r.id) ?? [])),
    0,
  );
  const header = [
    ...COLUMNS,
    ...(maxYears > 0
      ? [
          'Contract Start',
          'Contract Years',
          // What the value is made of, as "Element: total" pairs — keeps the
          // element dimension in the sheet without one column per element.
          'Contract Elements',
          ...Array.from({ length: maxYears }, (_, i) => `Year ${i + 1} Value`),
        ]
      : []),
  ];

  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const split = splits.get(r.id) ?? [];
    const years = yearCount(split);
    const splitCells =
      maxYears > 0
        ? [
            split[0]?.periodStart ?? '',
            years > 0 ? String(years) : '',
            rowsToElements(split)
              .map(
                (el) =>
                  `${componentDisplayName(el.component, el.componentLabel)}: ` +
                  fromMinorUnits(
                    el.amountsMinor.reduce((a, b) => a + b, 0),
                    r.currency,
                  ).toFixed(2),
              )
              .join('; '),
            // Every element contributes to a year, so a year's value is the
            // sum down that column.
            ...Array.from({ length: maxYears }, (_, i) => {
              if (i >= years) return '';
              const yearTotal = split
                .filter((s) => s.yearIndex === i + 1)
                .reduce((acc, s) => acc + s.amountMinor, 0);
              return fromMinorUnits(yearTotal, r.currency).toFixed(2);
            }),
          ]
        : [];
    lines.push(
      [
        r.name,
        DEAL_STAGE_LABELS[r.stage] ?? r.stage,
        fromMinorUnits(r.amountMinor, r.currency).toFixed(2),
        r.currency,
        r.companyName ?? '',
        r.contactName ?? '',
        r.contactEmail ?? '',
        primaryOfferingOf(r.offerings)?.name ?? UNCATEGORIZED_LABEL,
        primaryOfferingOf(r.offerings)
          ? OFFERING_CATEGORY_LABELS[primaryOfferingOf(r.offerings)!.category]
          : '',
        String(r.offerings.length),
        (r.ownerId && ownerNames[r.ownerId]) || r.ownerId || '',
        r.expectedCloseDate ?? '',
        r.forecastCategory
          ? FORECAST_CATEGORY_LABELS[r.forecastCategory as ForecastCategory] ??
            r.forecastCategory
          : '',
        r.healthScore != null ? String(r.healthScore) : '',
        r.healthBand ?? '',
        r.approvalStatus,
        r.nextStep ?? '',
        r.competitor ?? '',
        r.source ?? '',
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
        ...splitCells,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/** RFC-4180 CSV escaping: quote fields containing comma, quote, or newline. */
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
