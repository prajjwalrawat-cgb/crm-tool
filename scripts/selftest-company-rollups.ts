/**
 * Self-test for the Companies list rollup columns.
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-company-rollups.ts
 *
 * The properties, and why each one is worth a test rather than a glance:
 *
 *   1. THE SORT URL ROUND-TRIPS. Sorting lives in the URL so a reload and
 *      a shared link reproduce the order. An unrecognised mode must fall
 *      all the way back to the default rather than half-applying — a
 *      `?sort=pipelin` typo that silently ordered by nothing would look
 *      exactly like a list that happened to be in that order.
 *
 *   2. EMPTY IS AN EM DASH, NEVER A ZERO OR A NaN. The whole reason this
 *      table earns its width is that a scan can skip absent values. A
 *      column of `0`s stops the eye on every row, and a `NaN` that
 *      escaped an aggregate would render as the literal string.
 *
 *   3. THE ROLLUPS EQUAL THE BASE TABLES. Computed against a fixture with
 *      hand-known answers, not against whatever production happens to
 *      hold: a rollup that is wrong in the same way as the query that
 *      checks it passes every test that shares its SQL.
 *
 *   4. WON-ONLY IS NOT DEAD. An account with one closed-won deal must
 *      report `openPipelineValue === 0` AND `openDealCount === 0` AND a
 *      real `wonLifetimeValue` — three separate facts the UI needs to
 *      render "— open / ₹12L won" instead of a row of dashes.
 *
 *   5. TOP STAGE IS THE MOST RECENTLY UPDATED *OPEN* DEAL. The tiebreak
 *      is the whole definition. A fixture account carries five deals
 *      whose stages, amounts and update times are all different, and the
 *      newest one is deliberately closed — so an implementation that
 *      forgot to exclude won/lost picks the wrong answer and says so.
 *
 *   6. THE CHIPS MATCH THE COLUMNS. "Has active deals" must return only
 *      rows the Deals column shows as non-empty, and Stale / Recently
 *      active must partition the same Last Activity value at the same
 *      threshold — no row in both, no row in neither. This is the bug the
 *      feature exists to close: before, the chips read `activity_logs`
 *      and the table read nothing, so a chip could not be checked.
 *
 *   7. KEYSET PAGING SURVIVES EVERY SORT MODE. An aggregate-ordered page
 *      boundary is where cursor pagination breaks: pages must not overlap
 *      and must not skip, in both directions, for every mode.
 *
 * 1 and 2 are pure and always run. 3-7 need a database and are skipped
 * (not failed) without one, matching the other selftests.
 *
 * The database checks build their own tenant and delete it afterwards, so
 * the test is deterministic and leaves nothing behind.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

import {
  COMPANY_SORTS,
  type CompanySort,
  parseCompanySort,
  type SortDir,
} from '../src/lib/companies/filters';
import {
  EMPTY_COMPANY_ROLLUP,
  formatCount,
  hasOpenPipeline,
  hasWonValue,
} from '../src/lib/companies/rollup';

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * 1. Sort URL round trip                                              *
 * ------------------------------------------------------------------ */

for (const mode of COMPANY_SORTS) {
  const parsed = parseCompanySort({ sort: mode, dir: 'asc' });
  check(
    `sort=${mode}&dir=asc round-trips`,
    parsed.sort === mode && parsed.dir === 'asc',
    JSON.stringify(parsed),
  );
}
check(
  'an unknown sort mode falls back to the default, not to "no order"',
  parseCompanySort({ sort: 'pipelin' }).sort === 'recent',
);
check(
  'an unknown direction falls back to desc',
  parseCompanySort({ sort: 'pipeline', dir: 'sideways' }).dir === 'desc',
);
check(
  'no params at all is the default mode',
  parseCompanySort({}).sort === 'recent' && parseCompanySort({}).dir === 'desc',
);

/* ------------------------------------------------------------------ *
 * 2. Empty states never render a zero, a NaN or an undefined          *
 * ------------------------------------------------------------------ */

check('formatCount(0) is an em dash', formatCount(0) === '—');
check('formatCount(null) is an em dash', formatCount(null) === '—');
check('formatCount(undefined) is an em dash', formatCount(undefined) === '—');
check('formatCount(NaN) is an em dash, not "NaN"', formatCount(NaN) === '—');
check(
  'formatCount(Infinity) is an em dash',
  formatCount(Number.POSITIVE_INFINITY) === '—',
);
check('formatCount(3) is "3"', formatCount(3) === '3');
check(
  'an account with nothing on it prints nothing anywhere',
  !hasOpenPipeline(EMPTY_COMPANY_ROLLUP) && !hasWonValue(EMPTY_COMPANY_ROLLUP),
);
check(
  'open deals worth zero still print — that is a data-entry gap, not an empty account',
  hasOpenPipeline({ ...EMPTY_COMPANY_ROLLUP, openDealCount: 2, openPipelineValue: 0 }),
);
check(
  'won-only renders distinctly from dead: won prints, open does not',
  !hasOpenPipeline({
    ...EMPTY_COMPANY_ROLLUP,
    wonDealCount: 1,
    wonLifetimeValue: 1_200_000_00,
  }) &&
    hasWonValue({
      ...EMPTY_COMPANY_ROLLUP,
      wonDealCount: 1,
      wonLifetimeValue: 1_200_000_00,
    }),
);

/* ------------------------------------------------------------------ *
 * 3-7. Database-backed properties                                     *
 * ------------------------------------------------------------------ */

const SLUG = 'zz-selftest-company-rollups';
const DAY = 24 * 60 * 60 * 1000;

/**
 * The page loop below feeds `nextCursor` straight back in, which is what a
 * browser does. `decodeCursor` itself is server-only, so this decodes the
 * base64url the same way rather than importing it — and going through the
 * real encoded string (rather than reusing the row) is the point: a cursor
 * that loses precision on the way out is exactly the bug being tested.
 */
function decodeCursorForTest(raw: string): {
  ts: string;
  id: string;
  n?: number;
} {
  const padded =
    raw.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (raw.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
    ts: string;
    id: string;
    n?: number;
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping the database checks.');
    report();
    return;
  }

  const { db, client } = await import('../src/db/index');
  const { listCompanies } = await import('../src/lib/companies/queries');
  const { runWithSystemContext } = await import('../src/lib/db-context');

  let tenantId: string | null = null;
  try {
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
    const [t] = (await db.execute(sql`
      INSERT INTO tenants (name, slug)
      VALUES ('ZZ Selftest Company Rollups', ${SLUG}) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    tenantId = t!.id;
    const tid = tenantId;

    /**
     * The fixture. Every account below exists to make one assertion
     * decidable; the amounts are distinct primes-ish numbers so a wrong
     * SUM cannot coincidentally equal a right one.
     */
    const co = async (name: string): Promise<string> => {
      const [row] = (await db.execute(sql`
        INSERT INTO companies (tenant_id, name) VALUES (${tid}::uuid, ${name})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return row!.id;
    };
    const deal = async (
      companyId: string,
      name: string,
      stage: string,
      amountMinor: number,
      updatedDaysAgo: number,
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO deals (tenant_id, company_id, name, stage, amount_minor,
                           currency, expected_close_date, created_at, updated_at)
        VALUES (${tid}::uuid, ${companyId}::uuid, ${name}, ${stage}::deal_stage,
                ${amountMinor}::bigint, 'INR', CURRENT_DATE + 30,
                NOW() - (${updatedDaysAgo}::int * INTERVAL '1 day'),
                NOW() - (${updatedDaysAgo}::int * INTERVAL '1 day'))
      `);
    };
    const activity = async (
      companyId: string,
      daysAgo: number,
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO activity_logs (tenant_id, actor_user_id, entity_type, entity_id, action, created_at)
        VALUES (${tid}::uuid, 'system', 'company', ${companyId}, 'updated',
                NOW() - (${daysAgo}::int * INTERVAL '1 day'))
      `);
    };

    // A: nothing has ever happened to this account.
    await co('A Zero Deals');

    // B: one closed-won deal and nothing live. The row this feature has to
    // stop rendering as a dead account.
    const bId = await co('B Won Only');
    await deal(bId, 'B-won', 'won', 1_200_000_00, 40);

    // C: three open deals (sum must be exact), one won, one lost. The
    // NEWEST deal on the account is the lost one, so `top_stage` is only
    // right if closed deals are excluded before the ordering, not after.
    const cId = await co('C Multi Open');
    await deal(cId, 'C-proposal', 'proposal', 300_000_00, 9);
    await deal(cId, 'C-qualified', 'qualified', 70_000_00, 4); // newest OPEN
    await deal(cId, 'C-negotiation', 'negotiation', 1_100_000_00, 6);
    await deal(cId, 'C-won', 'won', 500_000_00, 3);
    await deal(cId, 'C-lost', 'lost', 900_000_00, 1); // newest overall
    await db.execute(sql`
      INSERT INTO contacts (tenant_id, company_id, first_name, last_name)
      VALUES (${tid}::uuid, ${cId}::uuid, 'Fixture', 'One'),
             (${tid}::uuid, ${cId}::uuid, 'Fixture', 'Two')
    `);

    // D / E: the two sides of the staleness threshold, by company activity
    // only (no deals), so the Stale chip is tested on its own terms.
    const dId = await co('D Stale');
    await activity(dId, 90);
    const eId = await co('E Fresh');
    await activity(eId, 1);

    /**
     * Sixty filler accounts, so a page size of 25 (the smallest the size
     * enum allows) crosses two boundaries — and every one of their sort
     * keys is a TIE.
     *
     * That is the point. Keyset pagination on a distinct key is easy; it
     * breaks on the ties, where the only thing separating "next page" from
     * "the same page again" is the id tiebreak carrying the same direction
     * as the key. Twenty accounts share each `created_at` (to the
     * microsecond, forced here rather than hoped for), all sixty share a
     * pipeline of zero, and the activity timestamps collapse onto three
     * values. They carry no deals, so the chip and threshold assertions
     * above still name exactly one account each.
     */
    const FILLERS = 60;
    await db.execute(sql`
      INSERT INTO companies (tenant_id, name, created_at)
      SELECT ${tid}::uuid, 'F' || lpad(g::text, 2, '0'),
             (TIMESTAMPTZ '2026-01-01 00:00:00.000123+00' + ((g % 3) || ' hours')::interval)
      FROM generate_series(0, ${FILLERS - 1}) g
    `);
    await db.execute(sql`
      INSERT INTO activity_logs (tenant_id, actor_user_id, entity_type, entity_id, action, created_at)
      SELECT ${tid}::uuid, 'system', 'company', c.id::text, 'updated',
             NOW() - (((substring(c.name from 2))::int % 3) + 1 || ' days')::interval
      FROM companies c
      WHERE c.tenant_id = ${tid}::uuid AND c.name LIKE 'F%'
    `);
    const TOTAL = 5 + FILLERS;

    const fetchAll = async (
      opts: Parameters<typeof listCompanies>[1] = {},
    ) =>
      runWithSystemContext(tid, () =>
        listCompanies(tid, { size: 100, ...opts }),
      );

    const all = await fetchAll();
    const byName = new Map(all.items.map((r) => [r.name, r]));
    const A = byName.get('A Zero Deals')!;
    const B = byName.get('B Won Only')!;
    const C = byName.get('C Multi Open')!;

    check(
      'fixture loads every account',
      all.items.length === TOTAL,
      `${all.items.length} of ${TOTAL}`,
    );

    /* ---- 3 + 4: values equal the base tables ---- */
    check(
      'zero-deal account reports zeroes and nulls, not nulls everywhere',
      A.rollup.dealCount === 0 &&
        A.rollup.openPipelineValue === 0 &&
        A.rollup.wonLifetimeValue === 0 &&
        A.rollup.contactCount === 0 &&
        A.rollup.topStage === null &&
        A.rollup.lastActivityAt === null,
      JSON.stringify(A.rollup),
    );
    check(
      'won-only: open pipeline is 0 (not blank), won value is the deal amount',
      B.rollup.dealCount === 1 &&
        B.rollup.openDealCount === 0 &&
        B.rollup.wonDealCount === 1 &&
        B.rollup.openPipelineValue === 0 &&
        B.rollup.wonLifetimeValue === 1_200_000_00,
      JSON.stringify(B.rollup),
    );
    check(
      'won-only renders as "— open / ₹12L won", not as a dead account',
      !hasOpenPipeline(B.rollup) && hasWonValue(B.rollup),
    );
    check(
      'multi-open: open pipeline sums the three open deals only',
      C.rollup.openPipelineValue === 300_000_00 + 70_000_00 + 1_100_000_00,
      `${C.rollup.openPipelineValue}`,
    );
    check(
      'multi-open: won value excludes the lost deal',
      C.rollup.wonLifetimeValue === 500_000_00,
      `${C.rollup.wonLifetimeValue}`,
    );
    check(
      'multi-open: deal_count counts every deal, open_deal_count only the open ones',
      C.rollup.dealCount === 5 && C.rollup.openDealCount === 3,
      JSON.stringify([C.rollup.dealCount, C.rollup.openDealCount]),
    );
    check('multi-open: contacts counted', C.rollup.contactCount === 2);

    /* ---- 5: top stage tiebreak ---- */
    check(
      'top_stage is the most recently updated OPEN deal, not the newest deal',
      C.rollup.topStage === 'qualified',
      `${String(C.rollup.topStage)} (the newest deal on the account is lost)`,
    );
    check(
      'an account with no open deals has no top_stage',
      B.rollup.topStage === null && A.rollup.topStage === null,
    );

    /* ---- last_activity_at spans deals as well as activity rows ---- */
    check(
      'last_activity_at picks up a deal update even with no activity row',
      B.rollup.lastActivityAt !== null &&
        Math.abs(Date.now() - B.rollup.lastActivityAt.getTime() - 40 * DAY) <
          2 * DAY,
      String(B.rollup.lastActivityAt),
    );

    /* ---- 6: chips match the columns ---- */
    const hasDeals = await fetchAll({ filters: { hasDeals: true } });
    check(
      '"Has active deals" returns exactly the accounts with an open deal',
      hasDeals.items.length === 1 && hasDeals.items[0]!.name === 'C Multi Open',
      hasDeals.items.map((r) => r.name).join(', '),
    );
    check(
      'every "Has active deals" row shows a non-empty Deals cell and a Stage badge',
      hasDeals.items.every(
        (r) =>
          r.rollup.dealCount > 0 &&
          r.rollup.openDealCount > 0 &&
          formatCount(r.rollup.dealCount) !== '—' &&
          r.rollup.topStage !== null,
      ),
    );

    const stale = await fetchAll({ filters: { stale: true, staleDays: 30 } });
    const fresh = await fetchAll({ filters: { recentActivityDays: 30 } });
    const staleNames = new Set(stale.items.map((r) => r.name));
    const freshNames = new Set(fresh.items.map((r) => r.name));
    check(
      'Stale contains the 90-day-old account and the never-touched one',
      staleNames.has('D Stale') && staleNames.has('A Zero Deals'),
      [...staleNames].join(', '),
    );
    check(
      'Stale excludes the account touched yesterday',
      !staleNames.has('E Fresh'),
    );
    check(
      'Recently active contains the account touched yesterday',
      freshNames.has('E Fresh'),
      [...freshNames].join(', '),
    );
    check(
      'no account is both Stale and Recently active at the same threshold',
      [...staleNames].every((n) => !freshNames.has(n)),
    );
    check(
      'no account is neither — the two chips partition the list',
      all.items.every((r) => staleNames.has(r.name) || freshNames.has(r.name)),
      `${staleNames.size} stale + ${freshNames.size} fresh vs ${all.items.length} total`,
    );
    check(
      'every Stale row shows a Last Activity older than the threshold (or none)',
      stale.items.every(
        (r) =>
          r.rollup.lastActivityAt === null ||
          Date.now() - r.rollup.lastActivityAt.getTime() > 30 * DAY,
      ),
    );

    /* ---- value-threshold filters, independently ---- */
    const richOpen = await fetchAll({ filters: { minOpen: 1_000_000 } });
    check(
      'minOpen filters on open pipeline alone (won-only account excluded)',
      richOpen.items.length === 1 && richOpen.items[0]!.name === 'C Multi Open',
      richOpen.items.map((r) => r.name).join(', '),
    );
    const richWon = await fetchAll({ filters: { minWon: 1_000_000 } });
    check(
      'minWon filters on won value alone (the ₹12L won-only account matches)',
      richWon.items.length === 1 && richWon.items[0]!.name === 'B Won Only',
      richWon.items.map((r) => r.name).join(', '),
    );

    /* ---- 7: every sort mode, both directions, ordered and pageable ---- */
    const keyOf = (
      row: (typeof all.items)[number],
      mode: CompanySort,
    ): number => {
      switch (mode) {
        case 'deals':
          return row.rollup.dealCount;
        case 'pipeline':
          return row.rollup.openPipelineValue;
        case 'won':
          return row.rollup.wonLifetimeValue;
        case 'activity':
          return row.rollup.lastActivityAt?.getTime() ?? 0;
        case 'recent':
          return row.createdAt.getTime();
      }
    };

    for (const mode of COMPANY_SORTS) {
      for (const dir of ['asc', 'desc'] as SortDir[]) {
        const page = await fetchAll({ sort: mode, dir });
        const keys = page.items.map((r) => keyOf(r, mode));
        const ordered = keys.every((k, i) =>
          i === 0 ? true : dir === 'asc' ? k >= keys[i - 1]! : k <= keys[i - 1]!,
        );
        check(`sort=${mode} dir=${dir} is monotonic`, ordered, keys.join(' '));
        check(
          `sort=${mode} dir=${dir} returns every account`,
          page.items.length === TOTAL,
          `${page.items.length} of ${TOTAL}`,
        );

        // Walk the whole list a page at a time. 25 is the smallest size the
        // page-size enum admits, and 65 accounts put both boundaries inside
        // a group of rows whose sort key is identical — the only place a
        // keyset cursor can duplicate or drop anything.
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard++) {
          const p: Awaited<ReturnType<typeof fetchAll>> = await fetchAll({
            sort: mode,
            dir,
            size: 25,
            cursor: cursor ? decodeCursorForTest(cursor) : null,
          });
          seen.push(...p.items.map((r) => r.id));
          cursor = p.nextCursor;
          if (!cursor) break;
        }
        check(
          `sort=${mode} dir=${dir} pages without overlap or gaps`,
          seen.length === TOTAL && new Set(seen).size === TOTAL,
          `${seen.length} rows, ${new Set(seen).size} distinct, expected ${TOTAL}`,
        );
        check(
          `sort=${mode} dir=${dir} paged order equals unpaged order`,
          seen.join(',') === page.items.map((r) => r.id).join(','),
        );
      }
    }

    /* ---- the view never multiplies or drops a company ---- */
    const [counts] = (await db.execute(sql`
      SELECT (SELECT count(*) FROM companies WHERE tenant_id = ${tid}::uuid) AS c,
             (SELECT count(*) FROM company_rollups WHERE tenant_id = ${tid}::uuid) AS r
    `)) as unknown as Array<{ c: string; r: string }>;
    check(
      'company_rollups returns exactly one row per company',
      counts!.c === counts!.r,
      `${counts!.c} companies, ${counts!.r} rollup rows`,
    );
  } catch (err) {
    check('database checks ran', false, String(err));
  } finally {
    // Drop the fixture BEFORE closing the connection — the two were the
    // other way round once, and the cleanup ran against an ended client,
    // failed into its own warning, and left the tenant behind.
    if (tenantId) {
      try {
        await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
      } catch (err) {
        console.error(
          `WARNING: could not remove the fixture tenant ${SLUG} — delete it by hand. ${String(err)}`,
        );
      }
    }
    await client.end({ timeout: 5 });
    report();
  }
}

function report(): void {
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  [${r.detail}]` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed.`,
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
