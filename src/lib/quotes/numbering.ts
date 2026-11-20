import { eq, sql } from 'drizzle-orm';

import { organizationSettings } from '@/db/schema/organization-settings';
import { quoteSettings } from '@/db/schema/quotes';
import type { DbExecutor } from '@/lib/db-context';

import { fiscalYearLabel, formatQuoteNumber, type QuoteNumberFormat } from './numbering-format';

export { fiscalYearLabel, formatQuoteNumber, type QuoteNumberFormat };

const DEFAULT_FORMAT: QuoteNumberFormat = {
  prefix: 'Q',
  separator: '/',
  includeFiscalYear: true,
  padding: 4,
};

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
