/**
 * Database half of selftest-collections — loaded only with DATABASE_URL.
 * Two throwaway tenants; dropped afterwards.
 */
import { sql } from 'drizzle-orm';

type Check = (name: string, ok: boolean, detail?: string) => void;

const SLUG_A = 'zz-selftest-collections-a';
const SLUG_B = 'zz-selftest-collections-b';
const L = 100_000_00;

export async function runCollectionsDbChecks(check: Check): Promise<void> {
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const q = await import('../src/lib/collections/queries');
  const { buildDiagnostic } = await import('../src/lib/collections/diagnostic');

  try {
    await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
    const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Collections A', ${SLUG_A}) RETURNING id`)) as unknown as Array<{ id: string }>;
    const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Collections B', ${SLUG_B}) RETURNING id`)) as unknown as Array<{ id: string }>;
    const tid = ta!.id;
    const tidB = tb!.id;
    await db.execute(sql`
      INSERT INTO organization_settings (tenant_id, fiscal_year_start_month) VALUES (${tid}::uuid, 4)
      ON CONFLICT (tenant_id) DO UPDATE SET fiscal_year_start_month = 4
    `);

    const mkDeal = async (name: string, owner: string, lakhs: number, closedAt: string) => {
      const [r] = (await db.execute(sql`
        INSERT INTO deals (tenant_id, name, stage, amount_minor, currency, owner_id, closed_at, approval_status, expected_close_date)
        VALUES (${tid}::uuid, ${name}, 'won', ${lakhs * L}, 'INR', ${owner}, ${closedAt}::timestamptz, 'none', ${closedAt.slice(0, 10)}::date)
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return r!.id;
    };
    const mkInvoice = async (num: string, date: string, lakhs: number, createdBy: string) => {
      const [r] = (await db.execute(sql`
        INSERT INTO proforma_invoices (tenant_id, pi_number, pi_date, seller, buyer, total_minor, subtotal_minor, created_by)
        VALUES (${tid}::uuid, ${num}, ${date}, '{"name":"S"}'::jsonb, '{"name":"B"}'::jsonb, ${lakhs * L}, ${lakhs * L}, ${createdBy})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return r!.id;
    };

    const dFunder = await mkDeal('Funder deal', 'funder', 150, '2026-05-01T00:00:00Z');
    const dSteady = await mkDeal('Steady deal', 'steady', 120, '2026-05-15T00:00:00Z');
    await db.execute(sql`
      INSERT INTO sales_targets (tenant_id, user_id, fiscal_year, revenue_target_minor)
      VALUES (${tid}::uuid, 'funder', 2026, ${400 * L}), (${tid}::uuid, 'steady', 2026, ${400 * L}), (${tid}::uuid, 'slow', 2026, ${400 * L})
    `);

    await runWithSystemContext(tid, async () => {
      const settings = await q.getCollectionSettings(tid);
      check('db: a new workspace reads the 30-day default, marked unsaved', settings.standardCreditDays === 30 && !settings.saved);

      /* ---- approval lifecycle ---- */
      const byRep = await q.setDealCreditTerms({ tenantId: tid, dealId: dFunder, actorId: 'funder', days: 90, note: 'big logo', actorCanApprove: false, settings });
      check('db: a rep setting 90 days → needs approval, not approved', byRep.needsApproval && !byRep.approved);
      let t = await q.getDealCreditTerms(tid, dFunder);
      check('db: unapproved terms store no approver', t?.agreedCreditDays === 90 && t.approvedBy === null && t.setBy === 'funder');
      await q.approveDealCreditTerms(tid, dFunder, 'mgr');
      t = await q.getDealCreditTerms(tid, dFunder);
      check('db: approval records who and when', t?.approvedBy === 'mgr' && t.approvedAt instanceof Date);
      await q.setDealCreditTerms({ tenantId: tid, dealId: dFunder, actorId: 'funder', days: 120, note: null, actorCanApprove: false, settings });
      t = await q.getDealCreditTerms(tid, dFunder);
      check('db: changing the days clears the earlier approval', t?.agreedCreditDays === 120 && t.approvedBy === null);
      const byMgr = await q.setDealCreditTerms({ tenantId: tid, dealId: dSteady, actorId: 'mgr', days: 60, note: null, actorCanApprove: true, settings });
      check('db: a manager setting long terms approves them in the same step', byMgr.approved);
      await q.setDealCreditTerms({ tenantId: tid, dealId: dSteady, actorId: 'mgr', days: 30, note: null, actorCanApprove: true, settings });
      t = await q.getDealCreditTerms(tid, dSteady);
      check('db: terms at standard carry no approval', t?.agreedCreditDays === 30 && t.approvedBy === null);

      /* ---- invoices + payments ---- */
      const i1 = await mkInvoice('PI-1', '2026-05-02', 150, 'funder');
      const i2 = await mkInvoice('PI-2', '2026-05-16', 120, 'steady');
      const i3 = await mkInvoice('PI-3', '2026-06-01', 10, 'funder'); // left unlinked
      check('db: linking an invoice to a deal works', (await q.setInvoiceDeal({ tenantId: tid, invoiceId: i1, dealId: dFunder, creditDays: null })) === 'ok');
      await q.setInvoiceDeal({ tenantId: tid, invoiceId: i2, dealId: dSteady, creditDays: null });
      check(
        'db: linking to a deal in another tenant is refused',
        (await q.setInvoiceDeal({ tenantId: tid, invoiceId: i3, dealId: '00000000-0000-4000-8000-000000000000', creditDays: null })) === 'deal_not_found',
      );
      await q.addInvoicePayment({ tenantId: tid, invoiceId: i1, actorId: 'mgr', amountMinor: 50 * L, paidOn: '2026-08-01', reference: 'UTR1', note: null });
      await q.addInvoicePayment({ tenantId: tid, invoiceId: i2, actorId: 'mgr', amountMinor: 60 * L, paidOn: '2026-06-01', reference: null, note: null });
      await q.addInvoicePayment({ tenantId: tid, invoiceId: i2, actorId: 'mgr', amountMinor: 60 * L, paidOn: '2026-06-10', reference: null, note: null });
      const v1 = await q.getInvoiceCollection(tid, i1, '2026-12-31');
      check('db: invoice picks up the deal’s 120-day terms and owner', v1?.status.creditDays === 120 && v1.dealOwnerId === 'funder' && v1.status.creditDaysSource === 'deal');
      check('db: partial payment → partial, 100 L outstanding', v1?.status.state === 'partial' && v1.status.outstandingMinor === 100 * L);
      const v2 = await q.getInvoiceCollection(tid, i2, '2026-12-31');
      check('db: two partial payments reaching the total → paid on the second date', v2?.status.state === 'paid' && v2.status.fullyPaidOn === '2026-06-10' && v2.payments.length === 2);
      check(
        'db: an invoice with payments is detected (its delete is refused), one without is not',
        (await q.invoiceHasPayments(tid, i2)) && !(await q.invoiceHasPayments(tid, i3)),
      );
      const statuses = await q.invoiceStatusesFor(tid, [i1, i2, i3], '2026-12-31');
      check('db: list statuses for a page of invoices', statuses.size === 3 && statuses.get(i3)?.creditDaysSource === 'standard');

      /* ---- the report's database input → the diagnostic ---- */
      const input = await q.loadDiagnosticInput({ tenantId: tid, fiscalYear: 2026, startMonth: 4, period: 'fy', asOf: '2026-12-31' });
      const diag = buildDiagnostic(input);
      const funder = diag.rows.find((r) => r.ownerId === 'funder');
      check('db: booked deals come through with their terms', input.deals.length === 2 && funder?.avgAgreedCreditDays === 120 && funder.unapprovedOverrideDeals === 1);
      check('db: annual targets come through (400 L → 150/400)', funder?.achievementPct === 150 / 400);
      check('db: owners with a target but no activity still appear', diag.rows.some((r) => r.ownerId === 'slow'));
      check('db: collected total = sum of payment rows', diag.summary.collectedMinor === 170 * L);
      check('db: unlinked invoice counted as unattributed', diag.summary.unattributedInvoices === 1 && diag.summary.unattributedInvoicedMinor === 10 * L);
      const q1 = await q.loadDiagnosticInput({ tenantId: tid, fiscalYear: 2026, startMonth: 4, period: 'q1', asOf: '2026-12-31' });
      check('db: a quarter takes a quarter of the annual target', q1.targets.get('funder') === 100 * L);
      check('db: Q2 has no booked deals', (await q.loadDiagnosticInput({ tenantId: tid, fiscalYear: 2026, startMonth: 4, period: 'q2', asOf: '2026-12-31' })).deals.length === 0);

      /* ---- payments are removable, terms are not deletable ---- */
      const [pay] = (await tenantTransaction((tx) => tx.execute(sql`SELECT id FROM invoice_payments WHERE invoice_id = ${i1}::uuid`))) as unknown as Array<{ id: string }>;
      check('db: a mistyped payment can be removed', (await q.deleteInvoicePayment(tid, pay!.id)) === i1);
      let termsUndeletable = false;
      try {
        await tenantTransaction((tx) => tx.execute(sql`DELETE FROM deal_credit_terms WHERE deal_id = ${dFunder}::uuid`));
      } catch {
        termsUndeletable = true;
      }
      check('db: the app cannot delete credit terms (approval history)', termsUndeletable);
    });

    /* ---- tenant isolation ---- */
    const other = await runWithSystemContext(tidB, async () => ({
      terms: await q.getDealCreditTerms(tidB, dFunder),
      raw: (await tenantTransaction((tx) => tx.execute(sql`SELECT (SELECT count(*) FROM deal_credit_terms)::int AS t, (SELECT count(*) FROM invoice_payments)::int AS p`))) as unknown as Array<{ t: number; p: number }>,
    }));
    check('db: another tenant can’t read this tenant’s credit terms', other.terms === null);
    check('db: RLS hides credit terms and payments across tenants', other.raw[0]?.t === 0 && other.raw[0]?.p === 0);
  } finally {
    try {
      await db.execute(sql`DELETE FROM tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`);
    } catch (err) {
      console.error(`WARNING: could not remove fixture tenants ${SLUG_A}/${SLUG_B}: ${String(err)}`);
    }
    await client.end({ timeout: 5 });
  }
}
