import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for stage governance (migration 0060).
 *
 * Three halves:
 *   1. Pure — funnel ordering, the rollback/close-date predicates, and the
 *      quota-weight math.
 *   2. DB-backed — the `deal_governance_sync` trigger: it REJECTS an
 *      unexplained backward move, classifies every change correctly, keeps
 *      rollback_count and push_count from ever incrementing together, and
 *      recomputes quota_weight.
 *   3. Constraint — `chk_close_date_required` rejects raw SQL that would
 *      leave a deal in Proposal/Negotiation/Won without a date.
 *
 * The DB halves are the ones that matter. The rules are enforced in the
 * database precisely so that no write path can skip them, and a test that
 * only exercised the TypeScript would be testing the layer that CAN be
 * bypassed while ignoring the one that can't.
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
    CLOSE_DATE_REQUIRED_STAGES,
    SYSTEM_ROLLBACK_REASONS,
    DEWEIGHTED_QUOTA_WEIGHT,
    FULL_QUOTA_WEIGHT,
    QUOTA_DEWEIGHT_PUSH_COUNT,
    isDeweighted,
    isForwardTransition,
    isRollbackTransition,
    quotaWeightFor,
    stageRank,
    violatesCloseDateClear,
    violatesMissingCloseDate,
    weightedQuotaMinor,
  } = await import('../src/lib/deals/stage-governance');

  /* ---------------- 1. Pure ---------------- */

  check('lead ranks below qualified', stageRank('lead')! < stageRank('qualified')!);
  check(
    'won is the top of the funnel',
    stageRank('won')! > stageRank('negotiation')!,
  );
  check('hold is unranked (a parking state)', stageRank('hold') === null);
  check('lost is unranked (a parking state)', stageRank('lost') === null);

  check(
    'negotiation → proposal is a rollback',
    isRollbackTransition('negotiation', 'proposal'),
  );
  check(
    'negotiation → qualified is a rollback',
    isRollbackTransition('negotiation', 'qualified'),
  );
  check(
    'won → negotiation is a rollback (manager rejection reopens a deal)',
    isRollbackTransition('won', 'negotiation'),
  );
  check(
    'proposal → negotiation is NOT a rollback',
    !isRollbackTransition('proposal', 'negotiation') &&
      isForwardTransition('proposal', 'negotiation'),
  );
  // The distinction that keeps reps from being interrogated for normal work.
  check(
    'negotiation → hold is NOT a rollback (parking, not regression)',
    !isRollbackTransition('negotiation', 'hold'),
  );
  check(
    'negotiation → lost is NOT a rollback',
    !isRollbackTransition('negotiation', 'lost'),
  );
  check(
    'lost → negotiation is NOT a rollback (reopening is not regression)',
    !isRollbackTransition('lost', 'negotiation'),
  );
  check(
    'same stage is neither rollback nor forward',
    !isRollbackTransition('proposal', 'proposal') &&
      !isForwardTransition('proposal', 'proposal'),
  );

  // R1
  for (const s of CLOSE_DATE_REQUIRED_STAGES) {
    check(`${s} without a date violates R1`, violatesMissingCloseDate(s, null));
    check(
      `${s} with a date satisfies R1`,
      !violatesMissingCloseDate(s, '2026-12-01'),
    );
  }
  check(
    'an empty string counts as missing (a blanked date input posts "")',
    violatesMissingCloseDate('proposal', '   '),
  );
  check(
    'lead without a date is fine (it may not carry one at all)',
    !violatesMissingCloseDate('lead', null),
  );
  check(
    'qualified without a date is fine (the deliberate gap in the rule)',
    !violatesMissingCloseDate('qualified', null),
  );
  check(
    'hold without a date is fine — else a dateless deal has nowhere to go',
    !violatesMissingCloseDate('hold', null) &&
      !violatesMissingCloseDate('lost', null),
  );

  // R3
  check(
    'blanking an existing date while staying in Proposal violates R3',
    violatesCloseDateClear({
      nextStage: 'proposal',
      previousCloseDate: '2026-09-30',
      nextCloseDate: null,
    }),
  );
  check(
    'replacing the date with a later one is a pushback, not a clear',
    !violatesCloseDateClear({
      nextStage: 'proposal',
      previousCloseDate: '2026-09-30',
      nextCloseDate: '2026-11-30',
    }),
  );
  check(
    'clearing the date WHILE rolling back to Lead is allowed (R3 escape hatch)',
    !violatesCloseDateClear({
      nextStage: 'lead',
      previousCloseDate: '2026-09-30',
      nextCloseDate: null,
    }),
  );
  check(
    'a deal that never had a date is not "cleared"',
    !violatesCloseDateClear({
      nextStage: 'proposal',
      previousCloseDate: null,
      nextCloseDate: null,
    }),
  );

  // R6 — the threshold is STRICTLY greater-than.
  check(
    `${QUOTA_DEWEIGHT_PUSH_COUNT} pushes still count in full`,
    quotaWeightFor(QUOTA_DEWEIGHT_PUSH_COUNT) === FULL_QUOTA_WEIGHT,
  );
  check(
    `${QUOTA_DEWEIGHT_PUSH_COUNT + 1} pushes → half credit`,
    quotaWeightFor(QUOTA_DEWEIGHT_PUSH_COUNT + 1) === DEWEIGHTED_QUOTA_WEIGHT,
  );
  check('never pushed → full credit', quotaWeightFor(0) === FULL_QUOTA_WEIGHT);
  check(
    'a null counter (pre-migration row) → full credit, not a penalty',
    quotaWeightFor(null) === FULL_QUOTA_WEIGHT,
  );
  check('isDeweighted agrees with the weight', isDeweighted(0.5) && !isDeweighted(1));
  check(
    'R7 weighting rounds rather than truncating',
    weightedQuotaMinor(101, 0.5) === 51 && weightedQuotaMinor(100, 1) === 100,
  );

  /* ---------------- 2. DB-backed: the trigger ---------------- */

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
    actor = 'selftest-governance',
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${actor}, true)`);
      return fn(tx);
    });
  }

  const tRows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (tRows.length === 0) {
    console.error('No tenants.');
    process.exit(2);
  }
  const tenantId = tRows[0]!.id;
  console.log(`tenant=${tenantId}`);

  type Counters = {
    stage: string;
    expectedCloseDate: string | null;
    pushCount: number;
    rollbackCount: number;
    quotaWeight: string;
    lastStageChangedAt: Date | null;
  };

  async function readCounters(id: string): Promise<Counters> {
    return txAs(tenantId, async (tx) => {
      const [r] = await tx
        .select({
          stage: deals.stage,
          expectedCloseDate: deals.expectedCloseDate,
          pushCount: deals.pushCount,
          rollbackCount: deals.rollbackCount,
          quotaWeight: deals.quotaWeight,
          lastStageChangedAt: deals.lastStageChangedAt,
        })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)))
        .limit(1);
      return r as Counters;
    });
  }

  type AuditRow = {
    field_name: string;
    old_value: string | null;
    new_value: string | null;
    change_type: string;
    reason_code: string | null;
    reason_note: string | null;
    changed_by: string | null;
  };

  async function readAudit(id: string): Promise<AuditRow[]> {
    return txAs(tenantId, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT field_name, old_value, new_value, change_type,
               reason_code, reason_note, changed_by
          FROM deal_audit_log
         WHERE tenant_id = ${tenantId}::uuid AND deal_id = ${id}::uuid
         ORDER BY changed_at ASC, field_name ASC
      `)) as unknown as AuditRow[];
      return rows;
    });
  }

  /** Move a deal's stage, optionally supplying a rollback reason. */
  async function moveStage(
    id: string,
    stage: string,
    reason?: { code: string; note?: string },
  ): Promise<void> {
    await txAs(tenantId, async (tx) => {
      if (reason) {
        await tx.execute(
          sql`select set_config('app.stage_change_reason_code', ${reason.code}, true)`,
        );
        await tx.execute(
          sql`select set_config('app.stage_change_reason_note', ${reason.note ?? ''}, true)`,
        );
      }
      await tx.execute(
        sql`UPDATE deals SET stage = ${stage}::deal_stage
             WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid`,
      );
    });
  }

  let dealId = '';
  let legacyId = '';

  try {
    // A deal that starts dated at Qualified, so it can move up and back.
    [dealId] = await txAs(tenantId, async (tx) => {
      const [row] = await tx
        .insert(deals)
        .values({
          tenantId,
          name: 'selftest-governance deal',
          stage: 'qualified',
          amountMinor: 1_000_00,
          currency: 'INR',
          marginBps: 2000,
          expectedCloseDate: '2026-10-01',
          ownerId: 'selftest-governance',
        })
        .returning({ id: deals.id });
      return [row!.id];
    });

    let c = await readCounters(dealId);
    check(
      'a new deal starts at rollback_count 0 and full quota weight',
      c.rollbackCount === 0 && Number(c.quotaWeight) === 1,
      `rollbacks=${c.rollbackCount} weight=${c.quotaWeight}`,
    );

    /* --- forward progress --- */
    await moveStage(dealId, 'proposal');
    c = await readCounters(dealId);
    check(
      'a forward move does not increment rollback_count',
      c.stage === 'proposal' && c.rollbackCount === 0,
      `stage=${c.stage} rollbacks=${c.rollbackCount}`,
    );
    check(
      'a stage change stamps last_stage_changed_at',
      c.lastStageChangedAt != null,
    );
    let audit = await readAudit(dealId);
    check(
      'the forward move wrote exactly one audit row, classified forward_progress',
      audit.length === 1 &&
        audit[0]!.field_name === 'stage' &&
        audit[0]!.change_type === 'forward_progress' &&
        audit[0]!.old_value === 'qualified' &&
        audit[0]!.new_value === 'proposal',
      JSON.stringify(audit),
    );
    check(
      'the audit row is attributed to the actor from the GUC',
      audit[0]!.changed_by === 'selftest-governance',
      String(audit[0]!.changed_by),
    );

    /* --- R2: rollback without a reason is REJECTED --- */
    let rejected = false;
    try {
      await moveStage(dealId, 'qualified');
    } catch (err) {
      const msg = `${err instanceof Error ? err.message : String(err)} ${
        (err as { cause?: { message?: string } })?.cause?.message ?? ''
      }`;
      rejected = msg.includes('ROLLBACK_REASON_REQUIRED');
    }
    check('R2: a backward move with no reason code is rejected', rejected);
    c = await readCounters(dealId);
    check(
      'the rejected rollback left the deal where it was (nothing written)',
      c.stage === 'proposal' && c.rollbackCount === 0,
      `stage=${c.stage}`,
    );
    audit = await readAudit(dealId);
    check(
      'the rejected rollback wrote no audit row',
      audit.length === 1,
      `rows=${audit.length}`,
    );

    /* --- R2: rollback WITH a reason succeeds and is recorded --- */
    await moveStage(dealId, 'qualified', {
      code: 'budget_lost',
      note: 'client deferred to next FY',
    });
    c = await readCounters(dealId);
    check(
      'R2: a backward move with a reason increments rollback_count',
      c.stage === 'qualified' && c.rollbackCount === 1,
      `stage=${c.stage} rollbacks=${c.rollbackCount}`,
    );
    audit = await readAudit(dealId);
    const rb = audit.find((a) => a.change_type === 'rollback');
    check(
      'the rollback audit row carries the reason code and note',
      !!rb && rb.reason_code === 'budget_lost' &&
        rb.reason_note === 'client deferred to next FY',
      JSON.stringify(rb),
    );

    /* --- parking states need no reason --- */
    await moveStage(dealId, 'hold');
    c = await readCounters(dealId);
    check(
      'moving to Hold needs no rollback reason and does not count as one',
      c.stage === 'hold' && c.rollbackCount === 1,
      `stage=${c.stage} rollbacks=${c.rollbackCount}`,
    );
    audit = await readAudit(dealId);
    check(
      'the Hold move is logged as an edit, not progress or regression',
      audit.filter((a) => a.field_name === 'stage').at(-1)!.change_type === 'edit',
    );
    await moveStage(dealId, 'qualified');

    /* --- R4/R5: close-date classification --- */
    async function setDate(id: string, date: string | null): Promise<void> {
      await txAs(tenantId, async (tx) => {
        await tx.execute(
          sql`UPDATE deals SET expected_close_date = ${date}::date
               WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid`,
        );
      });
    }

    const beforePushes = (await readCounters(dealId)).pushCount;
    await setDate(dealId, '2026-11-01');
    audit = await readAudit(dealId);
    check(
      'moving the date later is classified pushback',
      audit.filter((a) => a.field_name === 'expected_close_date').at(-1)!
        .change_type === 'pushback',
    );
    await setDate(dealId, '2026-10-15');
    audit = await readAudit(dealId);
    check(
      'pulling the date IN is classified edit, not pushback',
      audit.filter((a) => a.field_name === 'expected_close_date').at(-1)!
        .change_type === 'edit',
    );
    c = await readCounters(dealId);
    check(
      'only the forward date move counted as a push',
      c.pushCount === beforePushes + 1,
      `push_count=${c.pushCount}`,
    );

    // The checklist's explicit invariant: the two counters never move together.
    const beforeBoth = await readCounters(dealId);
    await setDate(dealId, '2026-12-25');
    const afterPush = await readCounters(dealId);
    check(
      'a date push increments push_count and NOT rollback_count',
      afterPush.pushCount === beforeBoth.pushCount + 1 &&
        afterPush.rollbackCount === beforeBoth.rollbackCount,
      `push=${afterPush.pushCount} rollback=${afterPush.rollbackCount}`,
    );
    await moveStage(dealId, 'proposal');
    await moveStage(dealId, 'qualified', { code: 'wrong_stage_advance' });
    const afterRollback = await readCounters(dealId);
    check(
      'a stage rollback increments rollback_count and NOT push_count',
      afterRollback.rollbackCount === afterPush.rollbackCount + 1 &&
        afterRollback.pushCount === afterPush.pushCount,
      `push=${afterRollback.pushCount} rollback=${afterRollback.rollbackCount}`,
    );

    /* --- the system rollback paths (secondary write paths) --- */
    // won -> negotiation is what a manager rejection does (rejectDealAction),
    // and qualified -> lead is the Lead-cleanup revert. Both are backward
    // moves, so both must supply a reason like any other. This is the
    // checklist's "spot-check the secondary write paths" item, made permanent.
    await setDate(dealId, '2027-06-30');
    await moveStage(dealId, 'proposal');
    await moveStage(dealId, 'negotiation');
    await moveStage(dealId, 'won');
    const beforeReject = await readCounters(dealId);
    await moveStage(dealId, 'negotiation', {
      code: SYSTEM_ROLLBACK_REASONS.approvalRejected,
      note: 'margin below floor',
    });
    const afterReject = await readCounters(dealId);
    audit = await readAudit(dealId);
    const sysRb = audit.filter((a) => a.change_type === 'rollback').at(-1)!;
    check(
      'a manager rejection (won → negotiation) records a system rollback reason',
      afterReject.stage === 'negotiation' &&
        afterReject.rollbackCount === beforeReject.rollbackCount + 1 &&
        sysRb.reason_code === SYSTEM_ROLLBACK_REASONS.approvalRejected,
      `stage=${afterReject.stage} code=${sysRb.reason_code}`,
    );

    /* --- amount is audited too --- */
    await txAs(tenantId, async (tx) => {
      await tx.execute(
        sql`UPDATE deals SET amount_minor = 2000000
             WHERE id = ${dealId}::uuid AND tenant_id = ${tenantId}::uuid`,
      );
    });
    audit = await readAudit(dealId);
    const amt = audit.filter((a) => a.field_name === 'amount_minor');
    check(
      'an amount change writes exactly one audit row, classified edit',
      amt.length === 1 && amt[0]!.change_type === 'edit' &&
        amt[0]!.new_value === '2000000',
      JSON.stringify(amt),
    );

    /* --- R6: quota weight crosses at >3 pushes --- */
    c = await readCounters(dealId);
    check(
      `still full weight at ${c.pushCount} pushes`,
      c.pushCount <= QUOTA_DEWEIGHT_PUSH_COUNT
        ? Number(c.quotaWeight) === 1
        : true,
      `push=${c.pushCount} weight=${c.quotaWeight}`,
    );
    // Push it over the line, one forward move at a time.
    const dates = ['2027-01-05', '2027-02-05', '2027-03-05', '2027-04-05'];
    for (const d of dates) await setDate(dealId, d);
    c = await readCounters(dealId);
    check(
      `push_count > ${QUOTA_DEWEIGHT_PUSH_COUNT} → quota_weight 0.50`,
      c.pushCount > QUOTA_DEWEIGHT_PUSH_COUNT && Number(c.quotaWeight) === 0.5,
      `push=${c.pushCount} weight=${c.quotaWeight}`,
    );
    check(
      'the TS helper and the trigger agree on the weight',
      quotaWeightFor(c.pushCount) === Number(c.quotaWeight),
      `ts=${quotaWeightFor(c.pushCount)} db=${c.quotaWeight}`,
    );

    /* --- R5: the log is append-only --- */
    let immutable = false;
    try {
      await txAs(tenantId, async (tx) => {
        await tx.execute(
          sql`UPDATE deal_audit_log SET reason_note = 'tampered'
               WHERE deal_id = ${dealId}::uuid`,
        );
      });
    } catch {
      immutable = true;
    }
    check('R5: an audit row cannot be updated', immutable);

    /* ---------------- 3. The CHECK constraint ---------------- */

    // R1 at the DB level: raw SQL that bypasses every service-layer check
    // must still be refused. This is the defense-in-depth claim, tested.
    // Nulls the date WITHOUT touching the stage: the deal is already sitting
    // in a date-required stage, so the constraint is the only thing that can
    // refuse this. Changing the stage in the same statement would trip the
    // rollback rule first and the assertion would pass for the wrong reason.
    const stageNow = (await readCounters(dealId)).stage;
    check(
      'the constraint test starts from a date-required stage',
      (CLOSE_DATE_REQUIRED_STAGES as readonly string[]).includes(stageNow),
      stageNow,
    );
    let constraintHeld = false;
    try {
      await txAs(tenantId, async (tx) => {
        await tx.execute(
          sql`UPDATE deals SET expected_close_date = NULL
               WHERE id = ${dealId}::uuid AND tenant_id = ${tenantId}::uuid`,
        );
      });
    } catch (err) {
      const msg = `${err instanceof Error ? err.message : String(err)} ${
        (err as { cause?: { message?: string } })?.cause?.message ?? ''
      }`;
      constraintHeld = msg.includes('chk_close_date_required');
    }
    check(
      'R1: raw SQL cannot blank the close date of a Proposal/Negotiation deal',
      constraintHeld,
    );

    let insertBlocked = false;
    try {
      [legacyId] = await txAs(tenantId, async (tx) => {
        const [row] = await tx
          .insert(deals)
          .values({
            tenantId,
            name: 'selftest-governance undated proposal',
            stage: 'proposal',
            amountMinor: 100,
            currency: 'INR',
            marginBps: 1000,
            expectedCloseDate: null,
            ownerId: 'selftest-governance',
          })
          .returning({ id: deals.id });
        return [row!.id];
      });
    } catch (err) {
      const msg = `${err instanceof Error ? err.message : String(err)} ${
        (err as { cause?: { message?: string } })?.cause?.message ?? ''
      }`;
      insertBlocked = msg.includes('chk_close_date_required');
    }
    check(
      'R1: an undated Proposal deal cannot be INSERTed either',
      insertBlocked,
    );
  } finally {
    await txAs(tenantId, async (tx) => {
      for (const id of [dealId, legacyId]) {
        if (!id) continue;
        // All three logs cascade with the deal; drop them explicitly anyway so
        // a partial failure can't leave orphaned rows behind. deal_audit_log
        // has no DELETE grant for app_user (it's append-only), so that one is
        // left to the cascade.
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

  console.log('\n─── Stage governance self-test ───');
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
