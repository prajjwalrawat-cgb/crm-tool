import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

import { DEMO_TENANT_NAMES, isDemoTenant } from './demo-allowlist';

config({ path: '.env.local' });
config();

/**
 * Demo seed for development/testing — produces a CRM that feels populated
 * but not noisy. Distinct from `seed-stress-data.ts` (which floods the DB
 * for pagination/perf testing); this one is shaped for the dashboard's
 * KPIs, the pipeline distribution, recent-activity, and workflow-health
 * widgets to all look "alive" at a glance.
 *
 * Tenant policy
 * -------------
 * This script will ONLY write into a tenant whose name appears in
 * `scripts/demo-allowlist.ts` (currently: "Test 1"). Real
 * production-like tenants must never receive seeded data. If the
 * allowlisted tenant doesn't exist yet, the script aborts with a
 * useful message — *no* fallback to "oldest tenant".
 *
 * Usage:
 *   pnpm seed:demo                            // wipes prior demo rows in the
 *                                              // allowlisted tenant, reseeds fresh
 *   pnpm seed:reset                           // wipes prior demo rows only
 *   DEMO_TENANT_NAME="Test 1" pnpm seed:demo  // override the target name
 *   TENANT_ID=<uuid> pnpm seed:demo           // explicit tenant id (must still
 *                                              // be on the allowlist)
 *
 * Tagging: every row written here is marked `metadata.demoSeed=true`
 * (on activity_logs + workflow_runs) so the reset path can delete only
 * demo data without touching real records. Companies/contacts/deals are
 * located via the activity_log creation rows tagged the same way.
 *
 * Counts (deliberately mid-sized for "feels populated, not flooded"):
 *   - 30 companies (Indian + international mix)
 *   - 50 contacts (most attached to a company; a few orphan)
 *   - 80 deals distributed across all stages, with stale + recent variety
 *   - ~140 activity rows (creates, stage moves, automation notes)
 *   - 14 workflow runs (mix of completed/failed/skipped/running)
 */

const RESET_ONLY =
  process.argv.includes('--reset-only') || process.env.RESET_ONLY === '1';
const SKIP_RESET = process.argv.includes('--no-reset');

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
type Stage = (typeof STAGES)[number];

const CURRENCIES = [
  { code: 'USD', weight: 0.6 },
  { code: 'INR', weight: 0.25 },
  { code: 'EUR', weight: 0.1 },
  { code: 'GBP', weight: 0.05 },
] as const;

const COMPANIES_INDIAN = [
  { name: 'Tata Consultancy Services', domain: 'tcs.com', industry: 'IT Services' },
  { name: 'Infosys', domain: 'infosys.com', industry: 'IT Services' },
  { name: 'Wipro', domain: 'wipro.com', industry: 'IT Services' },
  { name: 'HCL Technologies', domain: 'hcltech.com', industry: 'IT Services' },
  { name: 'Reliance Industries', domain: 'ril.com', industry: 'Conglomerate' },
  { name: 'Flipkart', domain: 'flipkart.com', industry: 'E-commerce' },
  { name: 'Zomato', domain: 'zomato.com', industry: 'Food Tech' },
  { name: 'Swiggy', domain: 'swiggy.com', industry: 'Food Tech' },
  { name: "BYJU'S", domain: 'byjus.com', industry: 'EdTech' },
  { name: 'Razorpay', domain: 'razorpay.com', industry: 'Fintech' },
  { name: 'Ola', domain: 'olacabs.com', industry: 'Mobility' },
  { name: 'Paytm', domain: 'paytm.com', industry: 'Fintech' },
  { name: 'Freshworks', domain: 'freshworks.com', industry: 'SaaS' },
  { name: 'Zoho', domain: 'zoho.com', industry: 'SaaS' },
  { name: 'Zerodha', domain: 'zerodha.com', industry: 'Fintech' },
];

const COMPANIES_INTL = [
  { name: 'Stripe', domain: 'stripe.com', industry: 'Fintech' },
  { name: 'Vercel', domain: 'vercel.com', industry: 'DevTools' },
  { name: 'Linear', domain: 'linear.app', industry: 'SaaS' },
  { name: 'Notion', domain: 'notion.so', industry: 'SaaS' },
  { name: 'Figma', domain: 'figma.com', industry: 'Design' },
  { name: 'Anthropic', domain: 'anthropic.com', industry: 'AI' },
  { name: 'Cloudflare', domain: 'cloudflare.com', industry: 'Infrastructure' },
  { name: 'Supabase', domain: 'supabase.com', industry: 'Infrastructure' },
  { name: 'Datadog', domain: 'datadoghq.com', industry: 'Observability' },
  { name: 'MongoDB', domain: 'mongodb.com', industry: 'Database' },
  { name: 'Atlassian', domain: 'atlassian.com', industry: 'SaaS' },
  { name: 'Shopify', domain: 'shopify.com', industry: 'E-commerce' },
  { name: 'Airtable', domain: 'airtable.com', industry: 'SaaS' },
  { name: 'Snowflake', domain: 'snowflake.com', industry: 'Data Platform' },
  { name: 'Twilio', domain: 'twilio.com', industry: 'Communications' },
];

const FIRST_NAMES = [
  // Indian
  'Arjun', 'Priya', 'Rahul', 'Ananya', 'Vikram', 'Shreya', 'Karthik', 'Neha',
  'Aditya', 'Pooja', 'Rohan', 'Divya', 'Sandeep', 'Kavya', 'Manish', 'Riya',
  'Anand', 'Tanvi', 'Ravi', 'Meera',
  // International
  'Sarah', 'James', 'Olivia', 'Michael', 'Emma', 'David', 'Sophia', 'Daniel',
  'Isabella', 'Ethan', 'Mia', 'Alexander', 'Charlotte', 'William', 'Amelia',
  'Lucas', 'Harper', 'Benjamin', 'Evelyn', 'Henry',
];

const LAST_NAMES = [
  // Indian
  'Sharma', 'Patel', 'Kumar', 'Singh', 'Reddy', 'Iyer', 'Nair', 'Mehta',
  'Rao', 'Gupta', 'Joshi', 'Shah', 'Verma', 'Khanna', 'Bose',
  // International
  'Anderson', 'Thompson', 'Garcia', 'Martinez', 'Lee', 'Wilson', 'Brown',
  'Johnson', 'Davis', 'Miller', 'Wang', 'Chen', 'Kim', 'Rossi', 'Müller',
];

const TITLES = [
  'Founder', 'CEO', 'CTO', 'VP Sales', 'VP Engineering', 'Engineering Manager',
  'Product Manager', 'Account Executive', 'CFO', 'Head of Operations',
  'Director of Marketing', 'Head of Customer Success', 'Solutions Architect',
];

const DEAL_NAME_TEMPLATES = [
  '{co} — Annual Subscription',
  '{co} — Enterprise Rollout',
  '{co} — Pilot Expansion',
  '{co} — Renewal',
  '{co} — Q{q} Upgrade',
  '{co} — Platform Migration',
  '{co} — Add-on Modules',
  '{co} — Seat Expansion',
  '{co} — Integration Project',
  '{co} — Strategic Partnership',
];

/**
 * Executive-friendly automation copy. Each line should read like a CRM
 * insight a sales operator would actually want surfaced, not debug
 * output. Boring system events (embedding regen, retention sweeps,
 * cache invalidations) are intentionally absent — they belong on the
 * /workflows page, not in the activity feed.
 */
const AUTOMATION_NOTES = [
  'Follow-up reminder scheduled for {n} days from now.',
  'Renewal opportunity flagged — close date approaches in {n} days.',
  'Stage stalled for {n} days — pinged the owner.',
  'Closed-won celebration sent to the channel.',
  'Quarterly review queued for next Monday.',
  'High-intent signal detected from the latest meeting summary.',
];

/**
 * Seeded "team members" — realistic-looking display names with deterministic
 * IDs so re-seeding gives the same distribution. The `seed-actor-` prefix
 * lets cleanup queries identify these without touching real Clerk-issued
 * user_XXX ids. Display info is also stored in each activity_log's
 * metadata.actor field so the renderer never has to call Clerk to resolve
 * these — and never falls back to printing a raw id.
 */
type SeedActor = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

const SEED_ACTORS: SeedActor[] = [
  { id: 'seed-actor-priya-sharma',    firstName: 'Priya',    lastName: 'Sharma',    email: 'priya.sharma@test1.example' },
  { id: 'seed-actor-rahul-mehta',     firstName: 'Rahul',    lastName: 'Mehta',     email: 'rahul.mehta@test1.example' },
  { id: 'seed-actor-meera-iyer',      firstName: 'Meera',    lastName: 'Iyer',      email: 'meera.iyer@test1.example' },
  { id: 'seed-actor-arjun-rao',       firstName: 'Arjun',    lastName: 'Rao',       email: 'arjun.rao@test1.example' },
  { id: 'seed-actor-sarah-chen',      firstName: 'Sarah',    lastName: 'Chen',      email: 'sarah.chen@test1.example' },
  { id: 'seed-actor-michael-torres',  firstName: 'Michael',  lastName: 'Torres',    email: 'michael.torres@test1.example' },
  { id: 'seed-actor-emma-wilson',     firstName: 'Emma',     lastName: 'Wilson',    email: 'emma.wilson@test1.example' },
];

function pickActor(): SeedActor {
  return SEED_ACTORS[Math.floor(Math.random() * SEED_ACTORS.length)]!;
}

function actorMeta(actor: SeedActor): {
  name: string;
  email: string;
  imageUrl: null;
} {
  return {
    name: `${actor.firstName} ${actor.lastName}`,
    email: actor.email,
    imageUrl: null,
  };
}

const WORKFLOW_IDS = [
  'deal-won',
  'deal-lost',
  'regenerate-embedding',
  'new-member-onboarding',
  'workflow-runs-retention',
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickCurrency(): string {
  const r = Math.random();
  let acc = 0;
  for (const c of CURRENCIES) {
    acc += c.weight;
    if (r <= acc) return c.code;
  }
  return 'USD';
}

function minutesAgo(m: number): Date {
  return new Date(Date.now() - m * 60_000);
}
function hoursAgo(h: number): Date {
  return minutesAgo(h * 60);
}
function daysAgo(d: number): Date {
  return hoursAgo(d * 24);
}
function randomPastWithin(days: number): Date {
  return new Date(Date.now() - randInt(0, days * 24 * 60) * 60_000);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { companies, contacts, deals, activityLogs, workflowRuns } =
    await import('../src/db/schema');

  // Resolve target tenant under the allowlist.
  //   - TENANT_ID env: must match a tenant whose name is on the allowlist.
  //   - DEMO_TENANT_NAME env: overrides the default name ("Test 1").
  //   - Default: look up the single allowlisted demo tenant by name.
  const explicitId = process.env.TENANT_ID;
  const targetName = process.env.DEMO_TENANT_NAME ?? DEMO_TENANT_NAMES[0];

  type TenantLookup = { id: string; name: string };
  let resolved: TenantLookup | null = null;

  if (explicitId) {
    const rows = (await db.execute(
      sql`SELECT id, name FROM tenants WHERE id = ${explicitId}::uuid LIMIT 1`,
    )) as unknown as TenantLookup[];
    resolved = rows[0] ?? null;
    if (!resolved) {
      console.error(`No tenant with id=${explicitId}.`);
      process.exit(2);
    }
  } else {
    if (!targetName) {
      console.error(
        'DEMO_TENANT_NAME is empty and the allowlist is empty too. ' +
          'Add a name to scripts/demo-allowlist.ts.',
      );
      process.exit(2);
    }
    const rows = (await db.execute(
      sql`SELECT id, name FROM tenants WHERE name = ${targetName} LIMIT 1`,
    )) as unknown as TenantLookup[];
    resolved = rows[0] ?? null;
    if (!resolved) {
      console.error(
        `No tenant named "${targetName}". The seed script refuses to fall ` +
          `back to another tenant. Create the org in Clerk first, sign in ` +
          `once so the tenant row is provisioned, then re-run.`,
      );
      process.exit(2);
    }
  }

  if (!isDemoTenant(resolved.name)) {
    console.error(
      `Refusing to seed tenant "${resolved.name}" — it is not on the demo ` +
        `allowlist (${DEMO_TENANT_NAMES.join(', ')}). Edit ` +
        `scripts/demo-allowlist.ts only if this tenant is genuinely a ` +
        `development/test fixture.`,
    );
    process.exit(3);
  }

  const tenantId = resolved.id;
  console.log(`tenant="${resolved.name}" id=${tenantId}`);

  /* -------- RESET (always, unless --no-reset) -------- */
  if (!SKIP_RESET) {
    const t0 = Date.now();

    // Workflow runs tagged demoSeed.
    await db.execute(
      sql`DELETE FROM workflow_runs
          WHERE tenant_id = ${tenantId}::uuid
            AND metadata->>'demoSeed' = 'true'`,
    );

    // Entities — locate ids via creation activity_log rows we tagged.
    await db.execute(
      sql`DELETE FROM deals
          WHERE id IN (
            SELECT entity_id::uuid
            FROM activity_logs
            WHERE tenant_id = ${tenantId}::uuid
              AND metadata->>'demoSeed' = 'true'
              AND entity_type = 'deal'
          )`,
    );
    await db.execute(
      sql`DELETE FROM contacts
          WHERE id IN (
            SELECT entity_id::uuid
            FROM activity_logs
            WHERE tenant_id = ${tenantId}::uuid
              AND metadata->>'demoSeed' = 'true'
              AND entity_type = 'contact'
          )`,
    );
    await db.execute(
      sql`DELETE FROM companies
          WHERE id IN (
            SELECT entity_id::uuid
            FROM activity_logs
            WHERE tenant_id = ${tenantId}::uuid
              AND metadata->>'demoSeed' = 'true'
              AND entity_type = 'company'
          )`,
    );

    // The activity logs themselves.
    await db.execute(
      sql`DELETE FROM activity_logs
          WHERE tenant_id = ${tenantId}::uuid
            AND metadata->>'demoSeed' = 'true'`,
    );

    console.log(`reset complete in ${Date.now() - t0}ms`);
  }

  if (RESET_ONLY) {
    console.log('reset-only flag set; skipping seed.');
    await client.end({ timeout: 5 });
    return;
  }

  /* -------- COMPANIES -------- */

  let phase = Date.now();
  const companyPool = [...COMPANIES_INDIAN, ...COMPANIES_INTL];
  const companyRows = companyPool.slice(0, 30).map((c) => ({
    tenantId,
    name: c.name,
    domain: c.domain,
    industry: c.industry,
    // Spread creation across last 120 days so the "oldest" companies feel
    // long-lived and "newest" feel fresh.
    createdAt: randomPastWithin(120),
    updatedAt: randomPastWithin(30),
  }));
  const insertedCompanies = (await db
    .insert(companies)
    .values(companyRows)
    .returning({
      id: companies.id,
      name: companies.name,
      createdAt: companies.createdAt,
    })) as Array<{ id: string; name: string; createdAt: Date }>;
  console.log(
    `  companies inserted: ${insertedCompanies.length} in ${Date.now() - phase}ms`,
  );

  /* -------- CONTACTS -------- */

  phase = Date.now();
  const contactRows = Array.from({ length: 50 }, (_, i) => {
    // 92% of contacts attach to a company; ~4 orphan contacts give the
    // entity list a realistic edge case.
    const attachToCompany = Math.random() < 0.92;
    const owner = attachToCompany
      ? insertedCompanies[i % insertedCompanies.length]!
      : null;
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const domain = owner
      ? insertedCompanies.find((c) => c.id === owner.id)?.name
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : 'example';
    return {
      tenantId,
      companyId: owner?.id ?? null,
      firstName: first,
      lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain ?? 'example'}.com`,
      title: pick(TITLES),
      phone: Math.random() < 0.6 ? `+91 9${randInt(100000000, 999999999)}` : null,
      createdAt: randomPastWithin(120),
      updatedAt: randomPastWithin(30),
    };
  });
  const insertedContacts = (await db
    .insert(contacts)
    .values(contactRows)
    .returning({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      companyId: contacts.companyId,
    })) as Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    companyId: string | null;
  }>;
  console.log(
    `  contacts  inserted: ${insertedContacts.length} in ${Date.now() - phase}ms`,
  );

  /* -------- DEALS -------- */

  phase = Date.now();

  // Deliberate stage distribution: roughly funnel-shaped on the open side,
  // tighter on closed. Add some stale deals (in early stage but inactive).
  const STAGE_PLAN: Array<{ stage: Stage; count: number }> = [
    { stage: 'lead', count: 20 },
    { stage: 'qualified', count: 18 },
    { stage: 'proposal', count: 15 },
    { stage: 'negotiation', count: 10 },
    { stage: 'won', count: 12 },
    { stage: 'lost', count: 5 },
  ];

  let dealIdx = 0;
  const dealRows: Array<typeof deals.$inferInsert & { __stage: Stage }> = [];
  for (const plan of STAGE_PLAN) {
    for (let i = 0; i < plan.count; i++) {
      const company = pick(insertedCompanies);
      const matchingContacts = insertedContacts.filter(
        (c) => c.companyId === company.id,
      );
      const contact =
        matchingContacts.length > 0
          ? pick(matchingContacts)
          : insertedContacts[i % insertedContacts.length] ?? null;
      const q = randInt(1, 4);
      const name = pick(DEAL_NAME_TEMPLATES)
        .replace('{co}', company.name)
        .replace('{q}', String(q));

      // Closed deals: closedAt 1–60d ago for variety.
      // Active deals: createdAt within last 90d.
      const isClosed = plan.stage === 'won' || plan.stage === 'lost';
      const isStaleInEarly =
        !isClosed &&
        (plan.stage === 'lead' || plan.stage === 'qualified') &&
        Math.random() < 0.25; // ~25% of leads/qualified are stale

      const createdAt = isStaleInEarly
        ? daysAgo(randInt(45, 120))
        : isClosed
          ? daysAgo(randInt(30, 180))
          : daysAgo(randInt(0, 60));
      const updatedAt = isStaleInEarly
        ? daysAgo(randInt(30, 90))
        : isClosed
          ? daysAgo(randInt(0, 60))
          : daysAgo(randInt(0, 14));
      const closedAt = isClosed
        ? // mix of recent wins/losses + older ones
          Math.random() < 0.5
          ? daysAgo(randInt(0, 7))
          : daysAgo(randInt(10, 60))
        : null;

      // Expected close date: forward-looking for active deals, with some
      // overdue ones to surface stale-deal alerts.
      const expectedDaysOut = isClosed
        ? null
        : Math.random() < 0.15
          ? -randInt(1, 14) // overdue
          : randInt(7, 60);

      const expectedCloseDate =
        expectedDaysOut !== null
          ? new Date(Date.now() + expectedDaysOut * 24 * 60 * 60_000)
              .toISOString()
              .slice(0, 10)
          : null;

      const currency = pickCurrency();
      // Amount realistic per currency.
      const amountMinor =
        currency === 'INR'
          ? randInt(50, 5000) * 100 * 1000 // ₹50k – ₹50L
          : randInt(2, 500) * 100 * 1000; // $2k – $500k

      // Assign a stable owner from the seed-actor pool so the deal
      // detail page can show "Owner: Priya Sharma" rather than a bare id.
      const owner = pickActor();
      dealRows.push({
        tenantId,
        companyId: company.id,
        contactId: contact?.id ?? null,
        name,
        stage: plan.stage,
        amountMinor,
        currency,
        expectedCloseDate,
        closedAt,
        ownerId: owner.id,
        createdAt,
        updatedAt,
        __stage: plan.stage,
      });
      dealIdx++;
    }
  }

  const insertedDeals = (await db
    .insert(deals)
    .values(dealRows.map(({ __stage, ...row }) => row))
    .returning({
      id: deals.id,
      name: deals.name,
      stage: deals.stage,
    })) as Array<{ id: string; name: string; stage: Stage }>;
  console.log(
    `  deals     inserted: ${insertedDeals.length} in ${Date.now() - phase}ms`,
  );

  /* -------- ACTIVITY LOGS -------- */

  phase = Date.now();
  const activityRows: Array<typeof activityLogs.$inferInsert> = [];

  // Creation rows (also our `demoSeed` anchors for cleanup). Each row
  // gets a random actor from SEED_ACTORS so the activity feed reads
  // like a small distributed sales team — not one bot.
  for (const c of insertedCompanies) {
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'company',
      entityId: c.id,
      action: 'created',
      metadata: { demoSeed: true, name: c.name, actor: actorMeta(actor) },
      createdAt: c.createdAt,
    });
  }
  for (const c of insertedContacts) {
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'contact',
      entityId: c.id,
      action: 'created',
      metadata: {
        demoSeed: true,
        name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
        actor: actorMeta(actor),
      },
      createdAt: randomPastWithin(90),
    });
  }
  for (const d of insertedDeals) {
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'deal',
      entityId: d.id,
      action: 'created',
      metadata: { demoSeed: true, name: d.name, actor: actorMeta(actor) },
      createdAt: randomPastWithin(60),
    });
  }

  // Stage-changed rows for closed deals — feeds the recent-wins widget.
  // Mid-funnel stage moves (lead → qualified → proposal etc.) for
  // ~30% of active deals so the feed reads like real pipeline motion.
  for (const d of insertedDeals.filter(
    (x) => x.stage === 'won' || x.stage === 'lost',
  )) {
    const fromStage = pick(['negotiation', 'proposal'] as const);
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'deal',
      entityId: d.id,
      action: 'stage_changed',
      metadata: {
        demoSeed: true,
        from: fromStage,
        to: d.stage,
        name: d.name,
        actor: actorMeta(actor),
      },
      createdAt:
        Math.random() < 0.5 ? daysAgo(randInt(0, 7)) : daysAgo(randInt(10, 60)),
    });
  }
  const midFunnel = insertedDeals.filter(
    (x) => x.stage !== 'won' && x.stage !== 'lost' && x.stage !== 'lead',
  );
  for (const d of midFunnel) {
    if (Math.random() > 0.35) continue;
    const stageOrder: Stage[] = [
      'lead',
      'qualified',
      'proposal',
      'negotiation',
    ];
    const toIdx = stageOrder.indexOf(d.stage as Stage);
    const fromStage = stageOrder[toIdx - 1];
    if (!fromStage) continue;
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'deal',
      entityId: d.id,
      action: 'stage_changed',
      metadata: {
        demoSeed: true,
        from: fromStage,
        to: d.stage,
        name: d.name,
        actor: actorMeta(actor),
      },
      createdAt: daysAgo(randInt(1, 30)),
    });
  }

  // Automation notes — executive-friendly only. No retention sweeps,
  // no embedding regens. Capped at 6 across the whole tenant so the
  // feed isn't dominated by bot voice.
  for (let i = 0; i < 6; i++) {
    const target = pick(insertedDeals);
    activityRows.push({
      tenantId,
      actorUserId: null,
      entityType: 'deal',
      entityId: target.id,
      action: 'automation_note',
      metadata: {
        demoSeed: true,
        name: target.name,
        message: pick(AUTOMATION_NOTES).replace(
          '{n}',
          String(randInt(3, 14)),
        ),
      },
      createdAt: randomPastWithin(20),
    });
  }

  // A few "minutes ago" rows so the feed has a live feel right after seeding.
  for (let i = 0; i < 4; i++) {
    const target = pick(insertedDeals);
    const actor = pickActor();
    activityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'deal',
      entityId: target.id,
      action: 'updated',
      metadata: {
        demoSeed: true,
        name: target.name,
        fields: ['notes'],
        actor: actorMeta(actor),
      },
      createdAt: minutesAgo(randInt(2, 50)),
    });
  }

  for (const batch of chunk(activityRows, 500)) {
    await db.insert(activityLogs).values(batch);
  }
  console.log(
    `  activity  inserted: ${activityRows.length} rows in ${Date.now() - phase}ms`,
  );

  /* -------- WORKFLOW RUNS -------- */

  phase = Date.now();
  type RunStatus = 'completed' | 'failed' | 'skipped' | 'running';
  const runPlan: Array<{
    workflowId: string;
    eventName: string | null;
    status: RunStatus;
    startedAgoMin: number;
    durationMs?: number;
    error?: string | null;
  }> = [
    // Recent successful wins → drives workflow-health "healthy" signal.
    { workflowId: 'deal-won', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 12, durationMs: 1840 },
    { workflowId: 'deal-won', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 90, durationMs: 1620 },
    { workflowId: 'deal-won', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 60 * 6, durationMs: 1755 },
    { workflowId: 'deal-won', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 60 * 26, durationMs: 1492 },
    { workflowId: 'deal-lost', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 60 * 4, durationMs: 1320 },
    { workflowId: 'deal-lost', eventName: 'crm/deal.stage_changed', status: 'completed', startedAgoMin: 60 * 50, durationMs: 1410 },
    { workflowId: 'regenerate-embedding', eventName: 'crm/ai.embed_entity', status: 'completed', startedAgoMin: 35, durationMs: 5200 },
    { workflowId: 'regenerate-embedding', eventName: 'crm/ai.embed_entity', status: 'completed', startedAgoMin: 60 * 12, durationMs: 4800 },
    { workflowId: 'new-member-onboarding', eventName: 'crm/member.invited', status: 'completed', startedAgoMin: 60 * 36, durationMs: 980 },
    { workflowId: 'workflow-runs-retention', eventName: 'cron/15 9 * * *', status: 'completed', startedAgoMin: 60 * 23, durationMs: 540 },
    { workflowId: 'workflow-runs-retention', eventName: 'cron/15 9 * * *', status: 'completed', startedAgoMin: 60 * 47, durationMs: 612 },
    // One skipped (idempotency belt) + one failed (so the failed counter > 0).
    { workflowId: 'deal-won', eventName: 'crm/deal.stage_changed', status: 'skipped', startedAgoMin: 60 * 28 },
    {
      workflowId: 'regenerate-embedding',
      eventName: 'crm/ai.embed_entity',
      status: 'failed',
      startedAgoMin: 60 * 8,
      durationMs: 2300,
      error: 'OpenAI rate limit exceeded — retried 3x, gave up',
    },
    // One running (orphaned) to give the ops page a recovery target.
    { workflowId: 'regenerate-embedding', eventName: 'crm/ai.embed_entity', status: 'running', startedAgoMin: 18 },
  ];

  const wfRows: Array<typeof workflowRuns.$inferInsert> = runPlan.map((r) => ({
    tenantId,
    workflowId: r.workflowId,
    eventName: r.eventName,
    inngestRunId: `local-demo-${Math.random().toString(36).slice(2, 14)}`,
    status: r.status,
    startedAt: minutesAgo(r.startedAgoMin),
    completedAt:
      r.status === 'running' || !r.durationMs
        ? null
        : new Date(minutesAgo(r.startedAgoMin).getTime() + r.durationMs),
    error: r.error ?? null,
    metadata: { demoSeed: true, source: 'local' },
  }));
  await db.insert(workflowRuns).values(wfRows);
  console.log(`  workflows inserted: ${wfRows.length} in ${Date.now() - phase}ms`);

  /* -------- SUMMARY -------- */

  console.log('\n  summary');
  console.log(`    companies:         ${insertedCompanies.length}`);
  console.log(`    contacts:          ${insertedContacts.length}`);
  console.log(`    deals:             ${insertedDeals.length}`);
  for (const plan of STAGE_PLAN) {
    console.log(`      ${plan.stage.padEnd(12)} ${plan.count}`);
  }
  console.log(`    activity rows:     ${activityRows.length}`);
  console.log(`    workflow runs:     ${wfRows.length}`);
  console.log('\n  done.\n');

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed-demo fatal:', err);
  process.exit(1);
});
