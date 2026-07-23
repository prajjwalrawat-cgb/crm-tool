import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { fromMinorUnits } from '@/lib/deals/currency';
import { parseDealFilters } from '@/lib/deals/filters';
import { decodeCursor, type Cursor } from '@/lib/pagination/cursor';
import { listDeals, type DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
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

  const rows = await runWithTenantContext({ tenantId: orgId, userId }, async () => {
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
    return all;
  });

  // Resolve owner display names in one batch.
  const ownerIds = Array.from(
    new Set(rows.map((r) => r.ownerId).filter((v): v is string => !!v)),
  );
  const ownerNames = await resolveAuthorLookup(ownerIds);

  const csv = buildCsv(rows, ownerNames);
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

function buildCsv(rows: DealRow[], ownerNames: Record<string, string>): string {
  const lines = [COLUMNS.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        DEAL_STAGE_LABELS[r.stage] ?? r.stage,
        fromMinorUnits(r.amountMinor, r.currency).toFixed(2),
        r.currency,
        r.companyName ?? '',
        r.contactName ?? '',
        r.contactEmail ?? '',
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
