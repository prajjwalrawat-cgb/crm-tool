import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for Module 5 (Duplicate Detection). Exercises the real
 * match + merge services against fixtures: trigram company match (the spec's
 * "Godavari Power" → "Godawari Power and Ispat Ltd"), the email-exact block,
 * and a full merge (child repoint + loser soft-delete/merged_into_id + audit
 * snapshot + exclusion from lists). Cleans up after itself.
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
  const { workspaceSettings, companies, contacts, deals, mergeAudit } = await import('../src/db/schema');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { normalizeCompanyName, normalizeContactName } = await import('../src/lib/dedup/normalize');
  const { findCompanyMatches, findContactByEmail, mergeRecords } = await import('../src/lib/dedup/queries');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
    includeDeleted = false,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'selftest-dedup', true)`);
      if (includeDeleted) {
        await tx.execute(sql`select set_config('app.include_deleted', 'true', true)`);
      }
      return fn(tx);
    });
  }

  const rows = (await db.execute(sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`)) as unknown as TenantRow[];
  if (rows.length === 0) { console.error('No tenants.'); process.exit(2); }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  const prior = await txAs(tenantId, async (tx) => {
    const r = await tx.select({ e: workspaceSettings.dedupEnabled }).from(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
    return r[0]?.e ?? null;
  });

  const TAG = `DEDUPTEST-${Date.now()}`;
  let godawariId = '', winnerId = '', loserId = '', dealId = '', contactId = '';

  try {
    await txAs(tenantId, async (tx) => {
      await tx.insert(workspaceSettings).values({ tenantId, dedupEnabled: true })
        .onConflictDoUpdate({ target: workspaceSettings.tenantId, set: { dedupEnabled: true } });
    });

    // 1. Company trigram match.
    const gName = `Godawari Power and Ispat Ltd (GPIL) ${TAG}`;
    godawariId = await txAs(tenantId, async (tx) => {
      const [c] = await tx.insert(companies).values({ tenantId, name: gName, normalizedName: normalizeCompanyName(gName) }).returning({ id: companies.id });
      return c!.id;
    });
    const matches = await runWithSystemContext(tenantId, () => findCompanyMatches(tenantId, `Godavari Power ${TAG}`));
    check('trigram match finds Godawari', matches.some((m) => m.id === godawariId), `matches=${matches.map((m) => m.label).join(' | ')}`);

    // 2. Email exact block (case-insensitive).
    const email = `dedup-${Date.now()}@sync-selftest.example`;
    contactId = await txAs(tenantId, async (tx) => {
      const [c] = await tx.insert(contacts).values({ tenantId, firstName: 'Dup', lastName: 'Contact', email, normalizedName: normalizeContactName('Dup', 'Contact') }).returning({ id: contacts.id });
      return c!.id;
    });
    const emailHit = await runWithSystemContext(tenantId, () => findContactByEmail(tenantId, email.toUpperCase()));
    check('email exact match (case-insensitive)', emailHit?.id === contactId, JSON.stringify(emailHit));

    // 3. Merge: winner + loser company, loser has a deal → repoint + audit.
    [winnerId, loserId] = await txAs(tenantId, async (tx) => {
      const [w] = await tx.insert(companies).values({ tenantId, name: `Acme Inc ${TAG}`, normalizedName: `acme ${TAG.toLowerCase()}` }).returning({ id: companies.id });
      const [l] = await tx.insert(companies).values({ tenantId, name: `Acme Incorporated ${TAG}`, normalizedName: `acme ${TAG.toLowerCase()}` }).returning({ id: companies.id });
      return [w!.id, l!.id];
    });
    dealId = await txAs(tenantId, async (tx) => {
      const [d] = await tx.insert(deals).values({ tenantId, name: `Merge deal ${TAG}`, stage: 'lead', companyId: loserId, amountMinor: 5000, currency: 'INR' }).returning({ id: deals.id });
      return d!.id;
    });

    const mergeRes = await runWithSystemContext(tenantId, () => mergeRecords('company', tenantId, winnerId, loserId, 'selftest-dedup'));
    check('merge ok', mergeRes.ok === true, JSON.stringify(mergeRes));

    await txAs(tenantId, async (tx) => {
      const [d] = await tx.select({ companyId: deals.companyId }).from(deals).where(eq(deals.id, dealId));
      check('deal repointed to winner', d?.companyId === winnerId, `companyId=${d?.companyId}`);

      const [audit] = await tx.select().from(mergeAudit).where(and(eq(mergeAudit.tenantId, tenantId), eq(mergeAudit.loserId, loserId)));
      const snap = audit?.loserSnapshot as { name?: string } | undefined;
      check('merge_audit row w/ loser snapshot', !!audit && snap?.name === `Acme Incorporated ${TAG}`, `snapName=${snap?.name}`);
      check('repointed_counts records the deal', (audit?.repointedCounts as Record<string, number>)?.deals === 1, JSON.stringify(audit?.repointedCounts));

      // Loser excluded from active list (merged_into_id IS NULL filter).
      const active = await tx.select({ id: companies.id }).from(companies).where(and(eq(companies.tenantId, tenantId), sql`${companies.mergedIntoId} IS NULL`, eq(companies.id, loserId)));
      check('loser excluded from active companies', active.length === 0);
    });

    // Read the (now soft-deleted) loser with include-deleted to verify the
    // merge bookkeeping was written.
    await txAs(tenantId, async (tx) => {
      const [l] = await tx
        .select({ mergedIntoId: companies.mergedIntoId, deletedAt: companies.deletedAt })
        .from(companies)
        .where(eq(companies.id, loserId));
      check('loser has merged_into_id + deleted_at', l?.mergedIntoId === winnerId && l?.deletedAt != null, `merged=${l?.mergedIntoId}`);
    }, true);
  } finally {
    await txAs(tenantId, async (tx) => {
      if (dealId) await tx.delete(deals).where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      if (loserId) await tx.delete(mergeAudit).where(and(eq(mergeAudit.tenantId, tenantId), eq(mergeAudit.loserId, loserId)));
      for (const id of [godawariId, winnerId, loserId]) if (id) await tx.delete(companies).where(and(eq(companies.id, id), eq(companies.tenantId, tenantId)));
      if (contactId) await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
      if (prior === null) await tx.delete(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
      else await tx.update(workspaceSettings).set({ dedupEnabled: prior }).where(eq(workspaceSettings.tenantId, tenantId));
    }, true);
  }

  console.log('\n─── Dedup self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => { console.error('selftest fatal:', err); process.exit(1); });
