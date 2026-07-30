import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for close-date pushback tracking (migration 0058).
 *
 * Two halves:
 *   1. Pure — the card's slip-severity thresholds and the overdue rule.
 *   2. DB-backed — the `deal_close_date_pushback_sync` trigger's semantics:
 *      original_close_date is write-once, only forward moves increment
 *      push_count, pull-ins and clears are logged but not counted, and
 *      total_slip_days always reflects (current − original).
 *
 * The DB half is the one that matters: every write path in the app goes
 * through that trigger, so its rules are the feature's real contract.
 */
type TenantRow = { id: string };
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { deals } = await import('../src/db/schema');
  const {
    isDealOverdue,
    slipSeverity,
    slipTooltip,
    SEVERE_PUSH_COUNT,
    SEVERE_SLIP_DAYS,
  } = await import('../src/lib/deals/slip');

  /* ---------------- 1. Pure: severity classification ---------------- */

  check(
    'never pushed → no indicator',
    slipSeverity({ pushCount: 0, totalSlipDays: 0 }) === 'none',
  );
  check(
    'pushed once, small slip → watch (amber chip only)',
    slipSeverity({ pushCount: 1, totalSlipDays: 4 }) === 'watch',
  );
  check(
    'pushed twice, under the day threshold → still watch',
    slipSeverity({ pushCount: 2, totalSlipDays: SEVERE_SLIP_DAYS - 1 }) ===
      'watch',
  );
  check(
    `pushed ${SEVERE_PUSH_COUNT}× → severe`,
    slipSeverity({ pushCount: SEVERE_PUSH_COUNT, totalSlipDays: 1 }) ===
      'severe',
  );
  check(
    `${SEVERE_SLIP_DAYS}+ days slipped on a single push → severe`,
    slipSeverity({ pushCount: 1, totalSlipDays: SEVERE_SLIP_DAYS }) ===
      'severe',
  );
  check(
    'null counters (pre-migration row) → no indicator',
    slipSeverity({ pushCount: null, totalSlipDays: null }) === 'none',
  );

  /* ---------------- 1b. Pure: overdue is independent ---------------- */

  const today = new Date('2026-07-30T00:00:00Z');
  check(
    'past close date on an open deal → overdue',
    isDealOverdue({ expectedCloseDate: '2026-07-01', stage: 'proposal' }, today),
  );
  check(
    'past close date on a Won deal → not overdue',
    !isDealOverdue({ expectedCloseDate: '2026-07-01', stage: 'won' }, today),
  );
  check(
    'past close date on a Lost deal → not overdue',
    !isDealOverdue({ expectedCloseDate: '2026-07-01', stage: 'lost' }, today),
  );
  check(
    'future close date → not overdue',
    !isDealOverdue({ expectedCloseDate: '2026-12-01', stage: 'proposal' }, today),
  );
  check(
    'no close date → not overdue',
    !isDealOverdue({ expectedCloseDate: null, stage: 'proposal' }, today),
  );
  check(
    'overdue is independent of pushback (never-pushed deal can be overdue)',
    isDealOverdue({ expectedCloseDate: '2026-07-01', stage: 'lead' }, today) &&
      slipSeverity({ pushCount: 0, totalSlipDays: 0 }) === 'none',
  );

  const tip = slipTooltip({
    originalCloseDate: '2026-08-31',
    expectedCloseDate: '2026-11-30',
    pushCount: 3,
    totalSlipDays: 91,
  });
  check(
    'tooltip names the original date, the current one, and both counters',
    tip.includes('Aug 31, 2026') &&
      tip.includes('Nov 30, 2026') &&
      tip.includes('pushed 3×') &&
      tip.includes('91 days'),
    tip,
  );

  /* ---------------- 2. DB-backed: the trigger ---------------- */

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
    actor = 'selftest-slip',
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${actor}, true)`);
      return fn(tx);
    });
  }

  const rows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (rows.length === 0) {
    console.error('No tenants.');
    process.exit(2);
  }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  type Counters = {
    expectedCloseDate: string | null;
    originalCloseDate: string | null;
    pushCount: number;
    lastPushedAt: Date | null;
    totalSlipDays: number;
  };

  async function readCounters(id: string): Promise<Counters> {
    return txAs(tenantId, async (tx) => {
      const [r] = await tx
        .select({
          expectedCloseDate: deals.expectedCloseDate,
          originalCloseDate: deals.originalCloseDate,
          pushCount: deals.pushCount,
          lastPushedAt: deals.lastPushedAt,
          totalSlipDays: deals.totalSlipDays,
        })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)))
        .limit(1);
      return r!;
    });
  }

  async function setCloseDate(
    id: string,
    date: string | null,
    reason?: string,
  ): Promise<void> {
    await txAs(tenantId, async (tx) => {
      if (reason) {
        await tx.execute(
          sql`select set_config('app.close_date_reason', ${reason}, true)`,
        );
      }
      await tx
        .update(deals)
        .set({ expectedCloseDate: date })
        .where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)));
    });
  }

  async function changeLog(id: string) {
    return txAs(tenantId, async (tx) => {
      const r = (await tx.execute(sql`
        SELECT old_close_date::text AS old_close_date,
               new_close_date::text AS new_close_date,
               changed_by, reason, is_push
        FROM deal_date_changes
        WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${id}::uuid
        ORDER BY changed_at ASC, id ASC
      `)) as unknown as Array<{
        old_close_date: string | null;
        new_close_date: string | null;
        changed_by: string | null;
        reason: string | null;
        is_push: boolean;
      }>;
      return r;
    });
  }

  let datedId = '';
  let bareId = '';

  try {
    // (a) A deal created WITH a date commits to it as the baseline.
    datedId = await txAs(tenantId, async (tx) => {
      const [d] = await tx
        .insert(deals)
        .values({
          tenantId,
          name: 'Slip Selftest — dated at creation',
          stage: 'qualified',
          amountMinor: 100000,
          currency: 'INR',
          expectedCloseDate: '2026-08-31',
        })
        .returning({ id: deals.id });
      return d!.id;
    });

    let c = await readCounters(datedId);
    check(
      'creation with a date sets original_close_date to it',
      c.originalCloseDate === '2026-08-31',
      String(c.originalCloseDate),
    );
    check(
      'a fresh deal starts at push_count 0 / 0 slip days / no last_pushed_at',
      c.pushCount === 0 && c.totalSlipDays === 0 && c.lastPushedAt === null,
      `${c.pushCount}/${c.totalSlipDays}/${String(c.lastPushedAt)}`,
    );
    check(
      'creation logs no change row (the baseline is not a change)',
      (await changeLog(datedId)).length === 0,
    );

    // (b) Push it out by 30 days — counted, dated, and logged with a reason.
    await setCloseDate(datedId, '2026-09-30', 'client procurement delay');
    c = await readCounters(datedId);
    check(
      'a later date increments push_count',
      c.pushCount === 1,
      String(c.pushCount),
    );
    check('a push stamps last_pushed_at', c.lastPushedAt !== null);
    check(
      'total_slip_days = current − original (30)',
      c.totalSlipDays === 30,
      String(c.totalSlipDays),
    );
    check(
      'original_close_date survives the push',
      c.originalCloseDate === '2026-08-31',
      String(c.originalCloseDate),
    );
    let log = await changeLog(datedId);
    check(
      'the push is logged with old → new, actor, reason, is_push',
      log.length === 1 &&
        log[0]!.old_close_date === '2026-08-31' &&
        log[0]!.new_close_date === '2026-09-30' &&
        log[0]!.changed_by === 'selftest-slip' &&
        log[0]!.reason === 'client procurement delay' &&
        log[0]!.is_push === true,
      JSON.stringify(log[0]),
    );

    // (c) Pull it back in — logged, but NOT a push, and the slip shrinks.
    await setCloseDate(datedId, '2026-09-10');
    c = await readCounters(datedId);
    check(
      'pulling a date in does NOT increment push_count',
      c.pushCount === 1,
      String(c.pushCount),
    );
    check(
      'total_slip_days is recomputed on a pull-in (10)',
      c.totalSlipDays === 10,
      String(c.totalSlipDays),
    );
    log = await changeLog(datedId);
    check(
      'the pull-in is still logged, flagged not-a-push, with no reason',
      log.length === 2 && log[1]!.is_push === false && log[1]!.reason === null,
      JSON.stringify(log[1]),
    );

    // (d) A no-op write leaves everything alone and logs nothing.
    await setCloseDate(datedId, '2026-09-10');
    c = await readCounters(datedId);
    check(
      'rewriting the same date is a no-op (no push, no log row)',
      c.pushCount === 1 && (await changeLog(datedId)).length === 2,
    );

    // (e) Two more pushes cross the severe threshold by count.
    await setCloseDate(datedId, '2026-09-15');
    await setCloseDate(datedId, '2026-09-20');
    c = await readCounters(datedId);
    check(
      'repeated pushes accumulate (3)',
      c.pushCount === 3,
      String(c.pushCount),
    );
    check(
      'a 3×-pushed deal classifies as severe',
      slipSeverity(c) === 'severe',
      `${c.pushCount}/${c.totalSlipDays}`,
    );

    // (f) An app write that tries to forge the counters is discarded.
    await txAs(tenantId, async (tx) => {
      await tx
        .update(deals)
        .set({
          expectedCloseDate: '2026-09-25',
          originalCloseDate: '2026-09-01',
          pushCount: 99,
          totalSlipDays: 999,
        })
        .where(and(eq(deals.id, datedId), eq(deals.tenantId, tenantId)));
    });
    c = await readCounters(datedId);
    check(
      'the trigger pins original_close_date against an app overwrite',
      c.originalCloseDate === '2026-08-31',
      String(c.originalCloseDate),
    );
    check(
      'the trigger owns push_count (99 discarded, real count is 4)',
      c.pushCount === 4,
      String(c.pushCount),
    );
    check(
      'the trigger owns total_slip_days (999 discarded, real slip is 25)',
      c.totalSlipDays === 25,
      String(c.totalSlipDays),
    );

    // (g) Clearing the date (the Lead revert path) is logged, not a push, and
    //     leaves nothing "slipping" — but the baseline survives for later.
    await setCloseDate(datedId, null);
    c = await readCounters(datedId);
    check(
      'clearing the date does not increment push_count',
      c.pushCount === 4,
      String(c.pushCount),
    );
    check(
      'clearing the date zeroes total_slip_days (nothing is committed)',
      c.totalSlipDays === 0,
      String(c.totalSlipDays),
    );
    check(
      'clearing the date keeps the original commitment on record',
      c.originalCloseDate === '2026-08-31',
      String(c.originalCloseDate),
    );

    // (h) Re-dating after a clear measures slip from the ORIGINAL commitment,
    //     not from zero — the deal has still moved out since it was promised.
    await setCloseDate(datedId, '2026-10-31');
    c = await readCounters(datedId);
    check(
      're-dating after a clear is not a push (there was no prior date)',
      c.pushCount === 4,
      String(c.pushCount),
    );
    check(
      're-dating measures slip from the original commitment (61)',
      c.totalSlipDays === 61,
      String(c.totalSlipDays),
    );

    // (i) A deal created BARE (Lead, no date) picks up its baseline on the
    //     first dated write — this is the common path in this codebase.
    bareId = await txAs(tenantId, async (tx) => {
      const [d] = await tx
        .insert(deals)
        .values({
          tenantId,
          name: 'Slip Selftest — bare at creation',
          stage: 'lead',
          amountMinor: 50000,
          currency: 'INR',
        })
        .returning({ id: deals.id });
      return d!.id;
    });
    c = await readCounters(bareId);
    check(
      'a bare deal has no baseline yet',
      c.originalCloseDate === null && c.pushCount === 0,
      String(c.originalCloseDate),
    );

    await setCloseDate(bareId, '2026-09-01');
    c = await readCounters(bareId);
    check(
      'the first date becomes the baseline, not a push',
      c.originalCloseDate === '2026-09-01' &&
        c.pushCount === 0 &&
        c.totalSlipDays === 0,
      `${String(c.originalCloseDate)}/${c.pushCount}/${c.totalSlipDays}`,
    );
    check(
      'the first date is still logged for the timeline',
      (await changeLog(bareId)).length === 1 &&
        (await changeLog(bareId))[0]!.old_close_date === null,
    );

    await setCloseDate(bareId, '2026-10-05');
    c = await readCounters(bareId);
    check(
      'pushing past the baseline counts and slips 34 days',
      c.pushCount === 1 && c.totalSlipDays === 34,
      `${c.pushCount}/${c.totalSlipDays}`,
    );
    check(
      '34 days slipped on one push classifies as severe',
      slipSeverity(c) === 'severe',
    );

    // (j) The reason GUC must not bleed across writes in the same tenant.
    await setCloseDate(bareId, '2026-10-06');
    const bareLog = await changeLog(bareId);
    check(
      'a later change carries no reason unless one was supplied',
      bareLog[bareLog.length - 1]!.reason === null,
      String(bareLog[bareLog.length - 1]!.reason),
    );
  } finally {
    await txAs(tenantId, async (tx) => {
      for (const id of [datedId, bareId]) {
        if (!id) continue;
        // deal_date_changes cascades on the deal delete; drop it explicitly
        // anyway so a partial failure can't leave orphaned log rows behind.
        await tx.execute(
          sql`DELETE FROM deal_date_changes WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${id}::uuid`,
        );
        await tx.execute(
          sql`DELETE FROM deal_stage_history WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${id}::uuid`,
        );
        await tx.delete(deals).where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)));
      }
    });
  }

  console.log('\n─── Close-date pushback self-test ───');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
