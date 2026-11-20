import { eq, sql } from 'drizzle-orm';

import { organizationSettings } from '@/db/schema/organization-settings';
import { quoteSettings } from '@/db/schema/quotes';
import type { DbExecutor } from '@/lib/db-context';

export type QuoteNumberFormat = {
  prefix: string;
  separator: string;
  includeFiscalYear: boolean;
  padding: number;
};

const DEFAULT_FORMAT: QuoteNumberFormat = {
  prefix: 'Q',
  separator: '/',
  includeFiscalYear: true,
  padding: 4,
};

/** startMonth 1 -> calendar year ('2026'); otherwise '2026-27'. isoDate is YYYY-MM-DD. */
export function fiscalYearLabel(isoDate: string, startMonth: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (startMonth <= 1) return String(year);
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function formatQuoteNumber(
  fmt: QuoteNumberFormat,
  fyLabel: string | null,
  seq: number,
): string {
  const parts = [fmt.prefix];
  if (fmt.includeFiscalYear && fyLabel) parts.push(fyLabel);
  parts.push(String(seq).padStart(fmt.padding, '0'));
  return parts.join(fmt.separator);
}

/**
 * Atomically allocates the next quote number for the tenant's fiscal year.
 * Must run inside a tenant transaction (RLS); the upsert row-locks the
 * sequence so concurrent callers get distinct values.
 */
export async function allocateQuoteNumber(
  tx: DbExecutor,
  tenantId: string,
  quoteDate: string,
): Promise<string> {
  const [s] = await tx
    .select()
    .from(quoteSettings)
    .where(eq(quoteSettings.tenantId, tenantId))
    .limit(1);
  const [org] = await tx
    .select({ m: organizationSettings.fiscalYearStartMonth })
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);

  const fmt: QuoteNumberFormat = s
    ? {
        prefix: s.numberPrefix,
        separator: s.numberSeparator,
        includeFiscalYear: s.numberIncludeFy,
        padding: s.numberPadding,
      }
    : DEFAULT_FORMAT;
  const label = fmt.includeFiscalYear
    ? fiscalYearLabel(quoteDate, org?.m ?? 1)
    : null;

  const rows = (await tx.execute(sql`
    INSERT INTO quote_number_sequences (tenant_id, fiscal_year, last_value)
    VALUES (${tenantId}, ${label ?? ''}, 1)
    ON CONFLICT (tenant_id, fiscal_year)
    DO UPDATE SET last_value = quote_number_sequences.last_value + 1
    RETURNING last_value
  `)) as unknown as Array<{ last_value: number }>;

  return formatQuoteNumber(fmt, label, rows[0]!.last_value);
}
