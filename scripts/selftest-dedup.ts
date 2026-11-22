import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold a real key: this test must never reach Claude.
process.env.ANTHROPIC_API_KEY = '';

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
  const extraCompanyIds: string[] = [];

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

    // 1b. A shared generic word is not a match: "L&T Technology" is not
    //     "Speridian Technology", but it is "L&T Technology Services".
    //     Random letters per name: a shared tag, numeric or not, would itself look alike.
    const word = (n: number) => Array.from({ length: n }, () => 'bcdfghjkmnpqrstvwxz'[Math.floor(Math.random() * 19)]).join('');
    // Short first words, like real ones ("Tata", "CGB"): long random ones would carry the score alone.
    const [spWord, cgbWord, tataWord, fooWord] = [word(9), word(3), word(4), word(4)];
    for (const n of [`Speridian${spWord} Technology`, `L&T Technology Services`]) {
      const id = await txAs(tenantId, async (tx) => {
        const [c] = await tx.insert(companies).values({ tenantId, name: n, normalizedName: normalizeCompanyName(n) }).returning({ id: companies.id });
        return c!.id;
      });
      extraCompanyIds.push(id);
    }
    const lt = await runWithSystemContext(tenantId, () => findCompanyMatches(tenantId, 'L&T Technology'));
    check('generic word alone does not match', !lt.some((m) => m.id === extraCompanyIds[0]), `matches=${lt.map((m) => m.label).join(' | ')}`);
    check('same distinctive name still matches', lt.some((m) => m.id === extraCompanyIds[1]), `matches=${lt.map((m) => m.label).join(' | ')}`);

    // 1c. The same first word is the same company name, whatever follows:
    //     "<X> Solutions" for "<X> Services", "<Y> Consultancy Services" for "<Y> Motors".
    const firstWordFixtures = [`${cgbWord} Solutions`, `${tataWord} Consultancy Services`];
    for (const n of firstWordFixtures) {
      const id = await txAs(tenantId, async (tx) => {
        const [c] = await tx.insert(companies).values({ tenantId, name: n, normalizedName: normalizeCompanyName(n) }).returning({ id: companies.id });
        return c!.id;
      });
      extraCompanyIds.push(id);
    }
    const cgb = await runWithSystemContext(tenantId, () => findCompanyMatches(tenantId, `${cgbWord} Services`));
    check('same first word, different generic ending matches', cgb.some((m) => m.id === extraCompanyIds[2]), `matches=${cgb.map((m) => m.label).join(' | ')}`);
    const tata = await runWithSystemContext(tenantId, () => findCompanyMatches(tenantId, `${tataWord} Motors Healthcare`));
    check('same first word, different distinctive ending matches', tata.some((m) => m.id === extraCompanyIds[3]), `matches=${tata.map((m) => m.label).join(' | ')}`);
    const other = await runWithSystemContext(tenantId, () => findCompanyMatches(tenantId, `${fooWord} Consultancy Services`));
    check('different first word does not match', !other.some((m) => m.id === extraCompanyIds[3]), `matches=${other.map((m) => m.label).join(' | ')}`);

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
      for (const id of [godawariId, winnerId, loserId, ...extraCompanyIds]) if (id) await tx.delete(companies).where(and(eq(companies.id, id), eq(companies.tenantId, tenantId)));
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
