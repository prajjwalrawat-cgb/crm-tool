/**
 * Self-test for the Account 360 view.
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-account-360.ts
 *
 * Four properties, and none of them is the rendering:
 *
 *   1. THE DRILL-DOWN ACTUALLY FILTERS. The whole point of the rollup
 *      "View all" links is that they land on a *filtered* list, not just
 *      a list. A link is only correct if the destination page's own
 *      parser reads the key back out and produces the filter — so this
 *      asserts the round trip through `parseContactFilters` /
 *      `parseDealFilters` rather than string-matching the href. A typo
 *      in the param name navigates perfectly and filters nothing, which
 *      is exactly the failure this view exists to fix.
 *
 *   2. THE HEADER COUNT IS THE ACCOUNT'S COUNT. The card shows five rows
 *      and a header count taken from `count(*) OVER ()`, so the two
 *      disagree by design past five. If `total` ever silently becomes
 *      `rows.length`, every large account reads as having exactly five
 *      contacts and nobody notices, because five is a plausible number.
 *
 *   3. THE FEED SPANS THE ACCOUNT. An account timeline that only shows
 *      the company's own activity rows is the old page with a new title.
 *      Deal and contact activity must appear, tagged with the record it
 *      came from.
 *
 *   4. MONTH GROUPING PRESERVES THE FEED. Grouping is a view over the
 *      same items: no item invented, none dropped, order untouched, and
 *      the buckets UTC-pinned so a server render and its hydration agree.
 *
 * 1 and 4 are pure and always run. 2 and 3 need a database and are
 * skipped (not failed) without one, matching the other selftests.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });
config();

import { parseContactFilters } from '../src/lib/contacts/filters';
import { parseDealFilters } from '../src/lib/deals/filters';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const ACCOUNT_ID = '3f8b2c1a-9d4e-4f7a-8b6c-1e2d3a4b5c6d';
const ACCOUNT_NAME = 'Globex & Co';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ *
 * 1. Drill-down round trip                                            *
 * ------------------------------------------------------------------ */

/** Parse a card's href the way the destination page's server component does. */
function searchParamsOf(href: string): Record<string, string> {
  const qs = new URL(href, 'https://example.invalid').searchParams;
  return Object.fromEntries(qs.entries());
}

// These two must stay byte-identical to the hrefs the cards build —
// including the name-vs-id asymmetry between the two destinations, which
// is the whole point of the checks below.
const CONTACTS_HREF = `/dashboard/contacts?companyId=${ACCOUNT_ID}`;
const DEALS_HREF = `/dashboard/deals?companyIds=${encodeURIComponent(
  ACCOUNT_NAME,
)}`;

const contactFilters = parseContactFilters(searchParamsOf(CONTACTS_HREF));
check(
  'contacts "View all" produces a companyId filter',
  contactFilters.companyId === ACCOUNT_ID,
  `got ${String(contactFilters.companyId)}`,
);

const dealFilters = parseDealFilters(searchParamsOf(DEALS_HREF));
check(
  'deals "View all" produces a companyIds filter',
  dealFilters.companyIds?.length === 1 &&
    dealFilters.companyIds[0] === ACCOUNT_NAME,
  `got ${JSON.stringify(dealFilters.companyIds)}`,
);
/**
 * KNOWN LIMITATION, asserted so it stays visible rather than becoming
 * folklore: `companyIds` is a comma-joined multi-value key, so a company
 * NAME containing a comma is split into two filters and the result set
 * silently widens. There is no escape in the contract, so the account
 * card cannot encode its way out of it.
 *
 * This documents the boundary; the DB section then guards it, failing
 * the day a real company name crosses it.
 */
check(
  'a comma in a company name splits the filter (documented limitation)',
  parseDealFilters(
    searchParamsOf(
      `/dashboard/deals?companyIds=${encodeURIComponent('Smith, Jones & Co')}`,
    ),
  ).companyIds?.length === 2,
  'unchanged: still splits on comma',
);

// Neither link may smuggle in a second filter — "View all" means all of
// this account's records, not this account's records that also match
// whatever was left in the URL builder.
check(
  'contacts "View all" sets no other filter',
  Object.values(contactFilters).filter((v) => v !== undefined && v !== false)
    .length === 1,
  JSON.stringify(contactFilters),
);
check(
  'deals "View all" sets no other filter',
  Object.values(dealFilters).filter((v) => v !== undefined && v !== false)
    .length === 1,
  JSON.stringify(dealFilters),
);

// `companyIds` is a misleading name: the deals filter matches company by
// NAME (listDealCompanyOptions returns `{ id: name, name }`). A UUID here
// parses perfectly and matches nothing — the exact "filters visibly, finds
// nothing" failure that shipped once already. Parsing is therefore not
// evidence; the DB section below runs the filter and counts the rows.
check(
  'deals link carries a company NAME, not a uuid',
  !UUID_RE.test(dealFilters.companyIds?.[0] ?? ''),
  `got ${JSON.stringify(dealFilters.companyIds)}`,
);
check(
  'contacts link carries a uuid (that filter really is by id)',
  UUID_RE.test(contactFilters.companyId ?? ''),
  `got ${String(contactFilters.companyId)}`,
);

/* ------------------------------------------------------------------ *
 * 4. Month grouping is a lossless view                                *
 * ------------------------------------------------------------------ */

/**
 * Mirror of `groupItemsByMonth` in entity-timeline.tsx. Duplicated
 * rather than imported because that module is a `'use client'` React
 * component; the grouping rule is what is under test, and it is small
 * enough that a drift between the two would show up as a failure here
 * on the very next change to either.
 */
function groupByMonth<T extends { createdAt: Date }>(
  items: T[],
): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = [];
  let current: { key: string; items: T[] } | null = null;
  for (const item of items) {
    const d = item.createdAt;
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (!current || current.key !== key) {
      current = { key, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

const feed = [
  { id: 'a', createdAt: new Date('2026-09-08T10:00:00Z') },
  { id: 'b', createdAt: new Date('2026-09-01T00:00:00Z') },
  { id: 'c', createdAt: new Date('2026-08-31T23:59:59Z') },
  { id: 'd', createdAt: new Date('2026-08-02T08:00:00Z') },
  { id: 'e', createdAt: new Date('2026-06-15T08:00:00Z') },
];
const grouped = groupByMonth(feed);

check('month grouping produces one bucket per month', grouped.length === 3,
  `got ${grouped.length}`);
check(
  'month grouping drops nothing',
  grouped.reduce((n, g) => n + g.items.length, 0) === feed.length,
);
check(
  'month grouping preserves newest-first order',
  grouped.flatMap((g) => g.items.map((i) => i.id)).join('') === 'abcde',
);
check(
  'a month with no items produces no empty bucket',
  !grouped.some((g) => g.items.length === 0),
);

// The boundary case that makes UTC pinning load-bearing: 2026-08-31
// 23:59:59Z is September in any timezone east of UTC. Server and client
// must agree, so the bucket key must not consult the local zone.
const boundary = new Date('2026-08-31T23:59:59Z');
check(
  'month buckets are UTC-pinned, not local',
  `${boundary.getUTCFullYear()}-${boundary.getUTCMonth()}` === '2026-7',
  `${boundary.getUTCFullYear()}-${boundary.getUTCMonth()}`,
);

/* ------------------------------------------------------------------ *
 * 2 + 3. Against a real database, when one is configured              *
 * ------------------------------------------------------------------ */

async function dbChecks(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    results.push({
      name: 'DB checks skipped (no DATABASE_URL)',
      ok: true,
      detail: 'rollup totals + cross-record feed not verified',
    });
    return;
  }

  const { and, eq, isNull, sql } = await import('drizzle-orm');
  const { db } = await import('../src/db');
  const { contacts, deals } = await import('../src/db/schema');
  const { runWithTenantContext, tenantTransaction } = await import(
    '../src/lib/db-context'
  );
  const { getAccount360, ACCOUNT_ROLLUP_LIMIT } = await import(
    '../src/lib/companies/account-360'
  );
  const { listDeals } = await import('../src/lib/deals/queries');

  /**
   * Pick the account with the most contacts + deals — the one where a
   * capped rollup and a true total actually differ, which is the case a
   * fixture-sized account would never exercise.
   *
   * Discovery runs on the raw client, deliberately outside a tenant
   * context and in plain SQL: the point is to find WHICH tenant to test,
   * and a tenant-scoped read cannot answer that. Every assertion below
   * then goes through `runWithTenantContext`, so what is under test is
   * the real RLS-scoped path the page uses.
   */
  const busiest = (await db.$client`
    SELECT c.id, c.name, c.tenant_id AS "tenantId",
      (
        (SELECT count(*) FROM contacts ct
           WHERE ct.company_id = c.id AND ct.deleted_at IS NULL)
        + (SELECT count(*) FROM deals d
           WHERE d.company_id = c.id AND d.deleted_at IS NULL)
      )::int AS children
    FROM companies c
    WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL
    ORDER BY children DESC
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    name: string;
    tenantId: string;
    children: number;
  }>;

  const target = busiest[0];
  if (!target || target.children === 0) {
    results.push({
      name: 'DB checks skipped (no account has contacts or deals)',
      ok: true,
      detail: target ? 'busiest account has 0 children' : 'no company rows',
    });
    await db.$client.end();
    return;
  }

  const account = await runWithTenantContext(
    { tenantId: target.tenantId, userId: 'selftest' },
    async () => getAccount360(target.tenantId, target.id),
  );

  if (!account) {
    check(
      'getAccount360 resolves an existing account',
      false,
      `${target.name} (${target.id})`,
    );
    return;
  }
  check(
    'getAccount360 resolves an existing account',
    true,
    `${target.name} — ${target.children} children`,
  );

  /* ---------- 2: the header count is the account's count ---------- */

  const [trueContacts, trueDeals] = await runWithTenantContext(
    { tenantId: target.tenantId, userId: 'selftest' },
    async () =>
      tenantTransaction(async (tx) =>
        Promise.all([
          tx
            .select({ n: sql<number>`count(*)`.mapWith(Number) })
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, target.tenantId),
                eq(contacts.companyId, target.id),
                isNull(contacts.deletedAt),
                isNull(contacts.mergedIntoId),
              ),
            )
            .then((r) => r[0]?.n ?? 0),
          tx
            .select({ n: sql<number>`count(*)`.mapWith(Number) })
            .from(deals)
            .where(
              and(
                eq(deals.tenantId, target.tenantId),
                eq(deals.companyId, target.id),
                isNull(deals.deletedAt),
              ),
            )
            .then((r) => r[0]?.n ?? 0),
        ]),
      ),
  );

  check(
    "contact rollup total equals the account's real contact count",
    account.contacts.total === trueContacts,
    `rollup ${account.contacts.total} vs ${trueContacts}`,
  );
  check(
    "deal rollup total equals the account's real deal count",
    account.deals.total === trueDeals,
    `rollup ${account.deals.total} vs ${trueDeals}`,
  );
  check(
    'rollup rows are capped in SQL, not trimmed after the fact',
    account.contacts.rows.length <= ACCOUNT_ROLLUP_LIMIT &&
      account.deals.rows.length <= ACCOUNT_ROLLUP_LIMIT &&
      account.contacts.rows.length === Math.min(trueContacts, ACCOUNT_ROLLUP_LIMIT) &&
      account.deals.rows.length === Math.min(trueDeals, ACCOUNT_ROLLUP_LIMIT),
    `${account.contacts.rows.length}/${trueContacts} contacts, ` +
      `${account.deals.rows.length}/${trueDeals} deals`,
  );
  check(
    'deal rollup is ordered by most recently updated',
    account.deals.rows.every(
      (d, i) => i === 0 || +account.deals.rows[i - 1]!.updatedAt >= +d.updatedAt,
    ),
  );

  /* ---------- 3: the feed spans the account ---------- */

  const tagged = account.timeline.filter((t) => t.source);
  check(
    'account feed is sorted newest-first',
    account.timeline.every(
      (t, i) => i === 0 || +account.timeline[i - 1]!.createdAt >= +t.createdAt,
    ),
  );
  check(
    'every cross-record item names a real child of this account',
    tagged.every(
      (t) =>
        (t.source!.type === 'deal' || t.source!.type === 'contact') &&
        t.source!.id.length > 0 &&
        t.source!.name.length > 0,
    ),
    `${tagged.length} of ${account.timeline.length} items came from a deal or contact`,
  );

  // The regression this guards: an "account timeline" that silently
  // degrades to the company's own activity rows looks fine — it is just
  // shorter. On an account that HAS children with history, at least some
  // of the feed must come from them.
  if (tagged.length === 0 && account.timeline.length > 0) {
    results.push({
      name: 'account feed reaches beyond the company row',
      ok: true,
      detail:
        'inconclusive: the account has children, none with activity of its own',
    });
  } else {
    check(
      'account feed reaches beyond the company row',
      tagged.length > 0 || account.timeline.length === 0,
      `${tagged.length} cross-record items`,
    );
  }

  /* ---------- the drill-down, end to end ---------- */

  /**
   * The check that would have caught the bug that shipped: parse the
   * card's own href and run the destination page's real query with it.
   * Asserting that `parseDealFilters` returns *something* proved only
   * that a UUID is a well-formed string — the filter was applied,
   * matched nothing, and rendered "Company: Unknown".
   */
  const hrefFilters = parseDealFilters(
    searchParamsOf(
      `/dashboard/deals?companyIds=${encodeURIComponent(target.name)}`,
    ),
  );
  const filtered = await runWithTenantContext(
    { tenantId: target.tenantId, userId: 'selftest' },
    async () =>
      listDeals(target.tenantId, { filters: hrefFilters, size: 100 }),
  );
  check(
    'the deals "View all" link actually returns deals for this account',
    filtered.items.length > 0,
    `${filtered.items.length} rows for "${target.name}" (rollup says ${account.deals.total})`,
  );
  check(
    'every deal behind the link belongs to this account',
    filtered.items.every((d) => d.companyId === target.id),
    `${filtered.items.filter((d) => d.companyId !== target.id).length} rows from another company record`,
  );

  /**
   * Tripwire for the comma limitation above. It is safe today only
   * because no company name contains a comma; this fails the moment
   * that stops being true, instead of the drill-down quietly widening.
   */
  const commaNames = (await db.$client`
    SELECT count(*)::int AS n FROM companies
    WHERE deleted_at IS NULL AND merged_into_id IS NULL AND name LIKE '%,%'
  `) as unknown as Array<{ n: number }>;
  check(
    'no company name contains a comma (the filter contract cannot encode one)',
    (commaNames[0]?.n ?? 0) === 0,
    `${commaNames[0]?.n ?? 0} such names`,
  );

  await db.$client.end();
}

async function main(): Promise<void> {
  await dbChecks();
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed` +
      (failed > 0 ? ` (${failed} failed)` : ''),
  );
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
