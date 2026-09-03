import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Stress-test seeder. Creates a configurable number of companies,
 * contacts, deals, and activity-log rows in a target tenant — useful
 * for verifying pagination, list virtualization, query plans on
 * non-trivial datasets, and the kanban interaction with many cards.
 *
 * Usage:
 *   pnpm tsx scripts/seed-stress-data.ts                       # defaults
 *   COUNT_COMPANIES=2000 COUNT_DEALS=2000 pnpm tsx scripts/seed-stress-data.ts
 *   TENANT_ID=<uuid> pnpm tsx scripts/seed-stress-data.ts      # specific tenant
 *
 * Inserts go through the connection role (postgres), which bypasses
 * RLS — fine for seeding into an existing tenant where we know the id.
 * For verification/cleanup we use a tagged metadata key
 * `seedRun=<runId>` so a single seed run can be wiped without touching
 * unrelated data.
 *
 * Each seed run:
 *   - inserts COUNT_COMPANIES with realistic-looking domains
 *   - inserts COUNT_CONTACTS, distributing them across companies
 *   - inserts COUNT_DEALS at a random stage with currency/amount noise
 *   - performs STAGE_MOVES random stage transitions (and emits
 *     `automation_note` activity-log rows so the activity feed has
 *     realistic depth)
 *
 * Prints elapsed time for each phase so the script doubles as a
 * lightweight benchmark.
 */

type SeedSummary = {
  runId: string;
  companies: number;
  contacts: number;
  deals: number;
  activity: number;
  totalMs: number;
};

const COUNT_COMPANIES = Number(process.env.COUNT_COMPANIES ?? '1000');
const COUNT_CONTACTS = Number(process.env.COUNT_CONTACTS ?? '1000');
const COUNT_DEALS = Number(process.env.COUNT_DEALS ?? '1000');
const STAGE_MOVES = Number(process.env.STAGE_MOVES ?? '500');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? '500');

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR'] as const;

const SAMPLE_NAMES = [
  'Acme', 'Globex', 'Initech', 'Stark Industries', 'Wonka', 'Tyrell', 'Pied Piper',
  'Hooli', 'Aperture', 'Umbrella', 'Wayne Enterprises', 'Cyberdyne', 'Soylent',
  'Vandelay', 'Massive Dynamic', 'Oscorp', 'Rekall', 'Weyland-Yutani',
];
const SAMPLE_FIRST = ['Alex', 'Sam', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Quinn'];
const SAMPLE_LAST = ['Smith', 'Patel', 'Garcia', 'Tanaka', 'Khan', 'Lee', 'Singh'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const {
    companies,
    contacts,
    deals,
    activityLogs,
  } = await import('../src/db/schema');

  // Resolve target tenant. Allow override via env; default to the
  // oldest tenant in the DB.
  const tenantId =
    process.env.TENANT_ID ??
    (
      (await db.execute(
        sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
      )) as unknown as Array<{ id: string }>
    )[0]?.id;
  if (!tenantId) {
    console.error('No tenant found. Pass TENANT_ID=<uuid> or sign in via the app first.');
    process.exit(2);
  }
  const runId = `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  console.log(
    `seeding tenant=${tenantId} runId=${runId}\n` +
      `  companies=${COUNT_COMPANIES}  contacts=${COUNT_CONTACTS}  deals=${COUNT_DEALS}  stageMoves=${STAGE_MOVES}\n`,
  );

  const totalStart = Date.now();
  const summary: SeedSummary = {
    runId,
    companies: 0,
    contacts: 0,
    deals: 0,
    activity: 0,
    totalMs: 0,
  };

  /* -------- COMPANIES -------- */

  let phase = Date.now();
  const companyRows = Array.from({ length: COUNT_COMPANIES }, (_, i) => {
    const base = pick(SAMPLE_NAMES);
    const name = `${base} ${i + 1}`;
    return {
      tenantId,
      name,
      domain: `${base.toLowerCase().replace(/[^a-z0-9]/g, '')}-${i + 1}.example`,
      industry: pick(['Software', 'Finance', 'Retail', 'Healthcare', 'Media']),
    };
  });
  const insertedCompanies: Array<{ id: string }> = [];
  for (const batch of chunk(companyRows, BATCH_SIZE)) {
    const ids = await db.insert(companies).values(batch).returning({ id: companies.id });
    insertedCompanies.push(...ids);
  }
  summary.companies = insertedCompanies.length;
  console.log(`  companies inserted: ${summary.companies} in ${Date.now() - phase}ms`);

  /* -------- CONTACTS -------- */

  phase = Date.now();
  const contactRows = Array.from({ length: COUNT_CONTACTS }, (_, i) => {
    const owner = insertedCompanies[i % insertedCompanies.length]!;
    const first = pick(SAMPLE_FIRST);
    const last = pick(SAMPLE_LAST);
    return {
      tenantId,
      companyId: owner.id,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${i + 1}@example.com`,
      title: pick(['Founder', 'VP Sales', 'Engineer', 'PM', 'Ops']),
    };
  });
  const insertedContacts: Array<{ id: string }> = [];
  for (const batch of chunk(contactRows, BATCH_SIZE)) {
    const ids = await db.insert(contacts).values(batch).returning({ id: contacts.id });
    insertedContacts.push(...ids);
  }
  summary.contacts = insertedContacts.length;
  console.log(`  contacts  inserted: ${summary.contacts} in ${Date.now() - phase}ms`);

  /* -------- DEALS -------- */

  phase = Date.now();
  const dealRows = Array.from({ length: COUNT_DEALS }, (_, i) => {
    const owner = insertedCompanies[i % insertedCompanies.length]!;
    const contactRow = insertedContacts[i % insertedContacts.length] ?? null;
    const stage = pick(STAGES);
    const closedAt = stage === 'won' || stage === 'lost' ? new Date() : null;
    // Proposal / Negotiation / Won require a close date (R1, migration 0060).
    // Lead must NOT carry one (violatesLeadCloseDate). Give every other stage
    // a date so the generator satisfies both rules whatever `pick` returns.
    const expectedCloseDate =
      stage === 'lead'
        ? null
        : (closedAt ?? new Date(Date.now() + randomInt(7, 90) * 86_400_000))
            .toISOString()
            .slice(0, 10);
    return {
      tenantId,
      companyId: owner.id,
      contactId: contactRow?.id ?? null,
      name: `Deal ${i + 1} - ${pick(['Q1', 'Q2', 'Q3', 'Q4'])} push`,
      stage,
      amountMinor: randomInt(50_000, 5_000_000),
      currency: pick(CURRENCIES),
      expectedCloseDate,
      closedAt,
    };
  });
  const insertedDeals: Array<{ id: string; stage: typeof STAGES[number] }> = [];
  for (const batch of chunk(dealRows, BATCH_SIZE)) {
    const ids = await db
      .insert(deals)
      .values(batch)
      .returning({ id: deals.id, stage: deals.stage });
    insertedDeals.push(...(ids as Array<{ id: string; stage: typeof STAGES[number] }>));
  }
  summary.deals = insertedDeals.length;
  console.log(`  deals     inserted: ${summary.deals} in ${Date.now() - phase}ms`);

  /* -------- ACTIVITY LOGS (creation rows) -------- */

  phase = Date.now();
  const creationLogs = [
    ...insertedCompanies.map((c) => ({
      tenantId,
      actorUserId: 'seed-stress-data',
      entityType: 'company' as const,
      entityId: c.id,
      action: 'created' as const,
      metadata: { seedRun: runId },
    })),
    ...insertedContacts.map((c) => ({
      tenantId,
      actorUserId: 'seed-stress-data',
      entityType: 'contact' as const,
      entityId: c.id,
      action: 'created' as const,
      metadata: { seedRun: runId },
    })),
    ...insertedDeals.map((d) => ({
      tenantId,
      actorUserId: 'seed-stress-data',
      entityType: 'deal' as const,
      entityId: d.id,
      action: 'created' as const,
      metadata: { seedRun: runId },
    })),
  ];
  for (const batch of chunk(creationLogs, BATCH_SIZE)) {
    await db.insert(activityLogs).values(batch);
  }
  summary.activity += creationLogs.length;
  console.log(
    `  activity  inserted: ${creationLogs.length} creation rows in ${Date.now() - phase}ms`,
  );

  /* -------- STAGE MOVES -------- */

  phase = Date.now();
  const moves: Array<{ id: string; from: string; to: string }> = [];
  for (let i = 0; i < STAGE_MOVES && insertedDeals.length > 0; i++) {
    const deal = pick(insertedDeals);
    const newStage = pick(STAGES);
    if (newStage === deal.stage) continue;
    moves.push({ id: deal.id, from: deal.stage, to: newStage });
    deal.stage = newStage;
  }
  // Apply each move + a stage-changed activity row.
  for (const batch of chunk(moves, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const m of batch) {
        await tx
          .update(deals)
          .set({ stage: m.to as typeof STAGES[number] })
          .where(sql`${deals.id} = ${m.id}::uuid`);
        await tx.insert(activityLogs).values({
          tenantId,
          actorUserId: 'seed-stress-data',
          entityType: 'deal',
          entityId: m.id,
          action: 'stage_changed',
          metadata: { seedRun: runId, from: m.from, to: m.to },
        });
      }
    });
  }
  summary.activity += moves.length;
  console.log(`  stage moves applied: ${moves.length} in ${Date.now() - phase}ms`);

  summary.totalMs = Date.now() - totalStart;
  console.log(
    `\n  done in ${summary.totalMs}ms.\n  tag for cleanup: metadata->>'seedRun' = '${runId}'`,
  );
  console.log(JSON.stringify(summary, null, 2));

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed fatal:', err);
  process.exit(1);
});
