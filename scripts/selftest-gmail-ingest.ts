import { config } from 'dotenv';
import { and, eq, inArray, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the Module 3 matching + write pipeline
 * (ingestSyncedMessage). Exercises everything the live Gmail sync would, minus
 * the network: fixture parsed messages → the pipeline → assertions on
 * email_messages / activity_logs / relationship_signals, idempotency, the
 * multi-open-deal needs_review path, and the "unknown address writes nothing"
 * privacy rule. Run via the `selftest` npm script (needs the server-only shim).
 *
 * Requires GMAIL not to be live — it never touches Google. It does require
 * EMAIL_SYNC_ENCRYPTION_KEY only for crypto imports NOT hit here (the pipeline
 * doesn't decrypt), so it runs without Gmail env configured.
 */

type TenantRow = { id: string };
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const MAILBOX = 'rep@sync-selftest.example';
const CONTACT_EMAIL = `client-${Date.now()}@acme-sync-selftest.example`;

async function main() {
  const { db, client } = await import('../src/db/index');
  const { workspaceSettings, contacts, deals, emailMessages, activityLogs, relationshipSignals } =
    await import('../src/db/schema');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { ingestSyncedMessage } = await import('../src/lib/email/gmail/ingest');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'selftest-gmail', true)`);
      return fn(tx);
    });
  }

  const rows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (rows.length === 0) {
    console.error('No tenants found.');
    process.exit(2);
  }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  const priorFlag = await txAs(tenantId, async (tx) => {
    const r = await tx.select({ e: workspaceSettings.emailSyncEnabled }).from(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
    return r[0]?.e ?? null;
  });

  let contactId = '';
  let dealAId = '';
  let dealBId = '';
  const externalIds: string[] = [];

  const mkMsg = (fromEmail: string, extId: string) => ({
    externalId: extId,
    threadId: 'thread-selftest',
    subject: 'Re: Proposal follow-up',
    snippet: 'Thanks — sending the PO shortly.',
    timestamp: Date.now(),
    from: [{ email: fromEmail, name: 'Client' }],
    to: [{ email: MAILBOX, name: 'Rep' }],
    cc: [],
  });

  try {
    await txAs(tenantId, async (tx) => {
      await tx
        .insert(workspaceSettings)
        .values({ tenantId, emailSyncEnabled: true })
        .onConflictDoUpdate({ target: workspaceSettings.tenantId, set: { emailSyncEnabled: true } });
    });

    // Contact + one open deal linked to it.
    contactId = await txAs(tenantId, async (tx) => {
      const [c] = await tx.insert(contacts).values({ tenantId, firstName: 'Sync', lastName: 'Client', email: CONTACT_EMAIL }).returning({ id: contacts.id });
      return c!.id;
    });
    dealAId = await txAs(tenantId, async (tx) => {
      const [d] = await tx.insert(deals).values({ tenantId, name: 'Sync Selftest Deal A', stage: 'qualified', contactId, amountMinor: 1000, currency: 'INR' }).returning({ id: deals.id });
      return d!.id;
    });

    const base = { tenantId, actorUserId: 'selftest-gmail', mailboxEmail: MAILBOX, excludedDomains: [] as string[], excludedAddresses: [] as string[] };

    // 1. Inbound from a known contact with one open deal → attach to that deal.
    const ext1 = `gmail-selftest-${Date.now()}-1`;
    externalIds.push(ext1);
    const r1 = await runWithSystemContext(tenantId, () =>
      ingestSyncedMessage({ ...base, message: mkMsg(CONTACT_EMAIL, ext1), direction: 'inbound' }),
    );
    check('inbound matched → created on the deal', r1.status === 'created' && r1.entityType === 'deal' && r1.entityId === dealAId && r1.needsReview === false, JSON.stringify(r1));

    // email_messages row correct + privacy (only snippet in textBody).
    await txAs(tenantId, async (tx) => {
      const [m] = await tx.select().from(emailMessages).where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.providerMessageId, ext1)));
      check('email_messages row: gmail/inbound/snippet-only', !!m && m.provider === 'gmail' && m.direction === 'inbound' && m.htmlBody === null && m.textBody === 'Thanks — sending the PO shortly.' && m.entityType === 'deal', m ? `${m.provider}/${m.direction}` : 'missing');
    });

    // activity_logs email_synced row present (counts for gates/scoring).
    await txAs(tenantId, async (tx) => {
      const a = await tx.select({ id: activityLogs.id }).from(activityLogs).where(and(eq(activityLogs.tenantId, tenantId), eq(activityLogs.entityId, dealAId), eq(activityLogs.action, 'email_synced')));
      check('activity_logs email_synced written', a.length === 1, `rows=${a.length}`);
    });

    // relationship_signals bumped inbound.
    await txAs(tenantId, async (tx) => {
      const [s] = await tx.select().from(relationshipSignals).where(and(eq(relationshipSignals.tenantId, tenantId), eq(relationshipSignals.entityType, 'deal'), eq(relationshipSignals.entityId, dealAId)));
      check('relationship_signals inbound bumped', !!s && s.totalInbound === 1 && s.lastInboundAt != null, s ? `in=${s.totalInbound}` : 'missing');
    });

    // 2. Idempotency: re-ingest the same message id → duplicate, no new row.
    const r2 = await runWithSystemContext(tenantId, () =>
      ingestSyncedMessage({ ...base, message: mkMsg(CONTACT_EMAIL, ext1), direction: 'inbound' }),
    );
    check('re-sync is idempotent (duplicate)', r2.status === 'duplicate');
    await txAs(tenantId, async (tx) => {
      const m = await tx.select({ id: emailMessages.id }).from(emailMessages).where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.providerMessageId, ext1)));
      check('no duplicate email_messages row', m.length === 1, `rows=${m.length}`);
    });

    // 3. Unknown address → writes nothing anywhere.
    const ext3 = `gmail-selftest-${Date.now()}-3`;
    const r3 = await runWithSystemContext(tenantId, () =>
      ingestSyncedMessage({ ...base, message: mkMsg('stranger@nowhere-selftest.example', ext3), direction: 'inbound' }),
    );
    check('unknown address → skipped no_contact', r3.status === 'skipped' && r3.reason === 'no_contact', JSON.stringify(r3));
    await txAs(tenantId, async (tx) => {
      const m = await tx.select({ id: emailMessages.id }).from(emailMessages).where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.providerMessageId, ext3)));
      check('unknown address wrote no email row', m.length === 0);
    });

    // 4. Multi-open-deal: add a 2nd open deal on the same contact → new message
    //    attaches to the most recent + needs_review.
    dealBId = await txAs(tenantId, async (tx) => {
      // expectedCloseDate is required from Proposal on (R1, migration 0060).
      // Incidental to what this test checks — it just needs a valid deal.
      const [d] = await tx.insert(deals).values({ tenantId, name: 'Sync Selftest Deal B', stage: 'proposal', contactId, amountMinor: 2000, currency: 'INR', expectedCloseDate: '2027-01-31' }).returning({ id: deals.id });
      return d!.id;
    });
    const ext4 = `gmail-selftest-${Date.now()}-4`;
    externalIds.push(ext4);
    const r4 = await runWithSystemContext(tenantId, () =>
      ingestSyncedMessage({ ...base, message: mkMsg(CONTACT_EMAIL, ext4), direction: 'inbound' }),
    );
    check('multi-deal → needs_review + most recent deal', r4.status === 'created' && r4.needsReview === true && r4.entityType === 'deal', JSON.stringify(r4));

    // 5. no-counterparty (only our own mailbox) → skipped no_counterparty.
    const r5 = await runWithSystemContext(tenantId, () =>
      ingestSyncedMessage({ ...base, message: { ...mkMsg(MAILBOX, `x-${Date.now()}`), to: [{ email: MAILBOX, name: 'Rep' }], from: [{ email: MAILBOX, name: 'Rep' }] }, direction: 'outbound' }),
    );
    check('only-self → skipped no_counterparty', r5.status === 'skipped' && r5.reason === 'no_counterparty', JSON.stringify(r5));
  } finally {
    await txAs(tenantId, async (tx) => {
      for (const id of [dealAId, dealBId]) {
        if (!id) continue;
        await tx.delete(activityLogs).where(and(eq(activityLogs.tenantId, tenantId), eq(activityLogs.entityId, id)));
        await tx.delete(relationshipSignals).where(and(eq(relationshipSignals.tenantId, tenantId), eq(relationshipSignals.entityId, id)));
        await tx.delete(deals).where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)));
      }
      if (externalIds.length) await tx.delete(emailMessages).where(and(eq(emailMessages.tenantId, tenantId), inArray(emailMessages.providerMessageId, externalIds)));
      if (contactId) await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
      if (priorFlag === null) await tx.delete(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
      else await tx.update(workspaceSettings).set({ emailSyncEnabled: priorFlag }).where(eq(workspaceSettings.tenantId, tenantId));
    });
  }

  console.log('\n─── Gmail ingest pipeline self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
