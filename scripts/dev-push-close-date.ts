import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Dev helper for eyeballing the close-date pushback UI (migration 0058).
 *
 * Pushing a deal's date three times through the UI takes a dozen clicks; this
 * does it in one command so you can see all three card states — no indicator,
 * amber chip, red chip + spine — on a real board immediately.
 *
 * It writes through the SAME path the app uses (role `app_user` + the
 * app.tenant_id / app.user_id GUCs), so the trigger, RLS and the change log all
 * behave exactly as they do for a real edit. Nothing here bypasses them.
 *
 * Safety: there is no default tenant and no default deal. Both must be named
 * explicitly, and the script prints what it is about to touch. `--reset` undoes
 * everything it did to a deal.
 *
 * Usage:
 *   # list candidate deals in a tenant (no writes)
 *   pnpm dev:push-date --tenant="Test11" --list
 *
 *   # push one deal's close date 3× by 15 days each, with a reason on the first
 *   pnpm dev:push-date --tenant="Test11" --deal="Acme" --pushes=3 --days=15
 *
 *   # one 45-day push (crosses the 30-day "severe" threshold on its own)
 *   pnpm dev:push-date --tenant="Test11" --deal="Acme" --pushes=1 --days=45
 *
 *   # make it overdue as well (sets the date into the past; not a push)
 *   pnpm dev:push-date --tenant="Test11" --deal="Acme" --overdue
 *
 *   # undo: clears this deal's change log and resets its counters
 *   pnpm dev:push-date --tenant="Test11" --deal="Acme" --reset
 */

const ACTOR = 'dev-push-date-script';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

type TenantRow = { id: string; name: string };
type DealRow = {
  id: string;
  name: string;
  stage: string;
  expected_close_date: string | null;
  original_close_date: string | null;
  push_count: number;
  total_slip_days: number;
};

async function main() {
  const { db, client } = await import('../src/db/index');

  const tenantArg = arg('tenant');
  if (!tenantArg) {
    console.error(
      'Refusing to guess. Pass --tenant="<name substring or uuid>" (see the header for usage).',
    );
    process.exit(2);
  }

  const tenants = (await db.execute(sql`
    SELECT id, name FROM tenants
    WHERE id::text = ${tenantArg} OR name ILIKE ${'%' + tenantArg + '%'}
    ORDER BY created_at
  `)) as unknown as TenantRow[];

  if (tenants.length !== 1) {
    console.error(
      tenants.length === 0
        ? `No tenant matched "${tenantArg}".`
        : `"${tenantArg}" matched ${tenants.length} tenants: ${tenants
            .map((t) => t.name)
            .join(', ')}. Narrow it or pass the uuid.`,
    );
    process.exit(2);
  }
  const tenant = tenants[0]!;
  console.log(`tenant: ${tenant.name} (${tenant.id})`);

  /** Every read/write runs as the app does: app_user + tenant/actor GUCs. */
  async function txAs<T>(
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
    reason?: string,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${ACTOR}, true)`);
      if (reason) {
        await tx.execute(
          sql`select set_config('app.close_date_reason', ${reason}, true)`,
        );
      }
      return fn(tx);
    });
  }

  async function listDeals(match?: string): Promise<DealRow[]> {
    return txAs(async (tx) =>
      (await tx.execute(sql`
        SELECT id, name, stage::text AS stage,
               expected_close_date::text AS expected_close_date,
               original_close_date::text AS original_close_date,
               push_count, total_slip_days
        FROM deals
        WHERE deleted_at IS NULL
          ${match ? sql`AND (id::text = ${match} OR name ILIKE ${'%' + match + '%'})` : sql``}
        ORDER BY updated_at DESC
        LIMIT 25
      `)) as unknown as DealRow[],
    );
  }

  function print(rows: DealRow[]): void {
    for (const d of rows) {
      console.log(
        `  ${d.name}  [${d.stage}]  close=${d.expected_close_date ?? '—'}` +
          `  original=${d.original_close_date ?? '—'}` +
          `  pushes=${d.push_count}  slip=${d.total_slip_days}d`,
      );
    }
  }

  if (flag('list')) {
    console.log('\nMost recently updated deals:');
    print(await listDeals());
    await client.end({ timeout: 5 });
    return;
  }

  const dealArg = arg('deal');
  if (!dealArg) {
    console.error('Pass --deal="<name substring or uuid>", or --list to browse.');
    process.exit(2);
  }

  const matches = await listDeals(dealArg);
  if (matches.length !== 1) {
    console.error(
      matches.length === 0
        ? `No deal in ${tenant.name} matched "${dealArg}".`
        : `"${dealArg}" matched ${matches.length} deals:`,
    );
    print(matches);
    process.exit(2);
  }
  const deal = matches[0]!;
  console.log('\nbefore:');
  print([deal]);

  /* -------- reset -------- */
  if (flag('reset')) {
    await txAs(async (tx) => {
      await tx.execute(
        sql`DELETE FROM deal_date_changes WHERE tenant_id = ${tenant.id}::uuid AND deal_id = ${deal.id}::uuid`,
      );
      // Deliberately does NOT touch expected_close_date, so the pushback
      // trigger doesn't fire and the counters can be reset to a clean baseline.
      await tx.execute(sql`
        UPDATE deals
           SET push_count = 0,
               total_slip_days = 0,
               last_pushed_at = NULL,
               original_close_date = expected_close_date
         WHERE id = ${deal.id}::uuid AND tenant_id = ${tenant.id}::uuid
      `);
    });
    console.log('\nafter (reset):');
    print(await listDeals(deal.id));
    await client.end({ timeout: 5 });
    return;
  }

  /* -------- overdue -------- */
  if (flag('overdue')) {
    const past = addDays(ymd(new Date()), -10);
    await txAs(async (tx) => {
      await tx.execute(sql`
        UPDATE deals SET expected_close_date = ${past}::date
         WHERE id = ${deal.id}::uuid AND tenant_id = ${tenant.id}::uuid
      `);
    });
    console.log(`\nset close date to ${past} (in the past — pulls in, not a push)`);
    print(await listDeals(deal.id));
    await client.end({ timeout: 5 });
    return;
  }

  /* -------- pushes -------- */
  const pushes = Number(arg('pushes') ?? '3');
  const days = Number(arg('days') ?? '15');
  if (!Number.isFinite(pushes) || pushes < 1 || pushes > 20) {
    console.error('--pushes must be 1..20');
    process.exit(2);
  }
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    console.error('--days must be 1..365');
    process.exit(2);
  }

  // A deal with no date has nothing to push out — give it one first. That first
  // write becomes the baseline, not a push (same rule the app follows).
  let current = deal.expected_close_date;
  if (!current) {
    current = addDays(ymd(new Date()), 20);
    await txAs(async (tx) => {
      await tx.execute(sql`
        UPDATE deals SET expected_close_date = ${current}::date
         WHERE id = ${deal.id}::uuid AND tenant_id = ${tenant.id}::uuid
      `);
    });
    console.log(`  (no close date — set baseline ${current})`);
  }

  const reasons = [
    'client procurement delay',
    'waiting on legal redlines',
    'budget moved to next quarter',
  ];
  for (let i = 0; i < pushes; i++) {
    const next = addDays(current!, days);
    await txAs(
      async (tx) => {
        await tx.execute(sql`
          UPDATE deals SET expected_close_date = ${next}::date
           WHERE id = ${deal.id}::uuid AND tenant_id = ${tenant.id}::uuid
        `);
      },
      // Leave the last push without a reason so the Date history shows both a
      // reasoned and an unreasoned entry.
      i < pushes - 1 ? reasons[i % reasons.length] : undefined,
    );
    console.log(`  push ${i + 1}: ${current} → ${next}`);
    current = next;
  }

  console.log('\nafter:');
  print(await listDeals(deal.id));
  console.log(
    '\nOpen /dashboard/deals/board — this card should now show the slip chip.' +
      '\nUndo with the same command plus --reset.',
  );
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
