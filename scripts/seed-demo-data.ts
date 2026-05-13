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

    // Tasks + notes + notifications are direct rows (no creation-log
    // indirection needed — all three tables carry tenant_id we can
    // scope to). Notifications: scoped to recipients that are seeded
    // actors so we never touch real users' notification streams.
    await db.execute(
      sql`DELETE FROM tasks
          WHERE tenant_id = ${tenantId}::uuid
            AND (created_by LIKE 'seed-actor-%' OR created_by = 'demo-seed')`,
    );
    await db.execute(
      sql`DELETE FROM notes
          WHERE tenant_id = ${tenantId}::uuid
            AND (author_user_id LIKE 'seed-actor-%' OR author_user_id = 'demo-seed')`,
    );
    await db.execute(
      sql`DELETE FROM notifications
          WHERE tenant_id = ${tenantId}::uuid
            AND recipient_user_id LIKE 'seed-actor-%'`,
    );
    await db.execute(
      sql`DELETE FROM comments
          WHERE tenant_id = ${tenantId}::uuid
            AND author_user_id LIKE 'seed-actor-%'`,
    );
    await db.execute(
      sql`DELETE FROM email_messages
          WHERE tenant_id = ${tenantId}::uuid
            AND actor_user_id LIKE 'seed-actor-%'
            AND metadata->>'seedDemo' = 'true'`,
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

  /* -------- TASKS -------- */

  phase = Date.now();
  const { tasks: tasksTable } = await import('../src/db/schema');
  const TASK_TITLES = [
    'Send pricing proposal',
    'Schedule renewal kickoff call',
    'Confirm legal review on MSA redlines',
    'Follow up on stalled negotiation',
    'Prepare quarterly business review deck',
    'Walk through integration architecture',
    'Loop in security team on SOC2 questions',
    'Draft renewal terms for review',
    'Coordinate proof-of-concept timeline',
    'Set up technical demo for engineering team',
    'Email summary after intro call',
    'Confirm decision-maker for the next stage',
    'Validate budget cycle and procurement steps',
    'Request reference customer for case study',
  ];
  const TASK_PRIORITIES_POOL: Array<'low' | 'medium' | 'high' | 'urgent'> = [
    'low',
    'medium',
    'medium',
    'medium',
    'high',
    'high',
    'urgent',
  ];

  // Seed ~40 tasks across deals and standalone. Mix of statuses.
  const taskRows: Array<typeof tasksTable.$inferInsert> = [];
  const dealsForTasks = insertedDeals.filter(
    (d) => d.stage !== 'won' && d.stage !== 'lost',
  );
  for (let i = 0; i < 40; i++) {
    const actor = pickActor();
    const linkedDeal =
      Math.random() < 0.75 && dealsForTasks.length > 0
        ? pick(dealsForTasks)
        : null;
    const dueDaysOffset = Math.random() < 0.18 ? -randInt(1, 21) : randInt(0, 21);
    // Status distribution: 55% todo, 20% in_progress, 20% completed, 5% cancelled.
    const r = Math.random();
    const status: 'todo' | 'in_progress' | 'completed' | 'cancelled' =
      r < 0.55
        ? 'todo'
        : r < 0.75
          ? 'in_progress'
          : r < 0.95
            ? 'completed'
            : 'cancelled';
    const completedAt =
      status === 'completed' ? daysAgo(randInt(0, 14)) : null;
    const dueDate =
      status === 'completed'
        ? null
        : new Date(Date.now() + dueDaysOffset * 24 * 60 * 60_000)
            .toISOString()
            .slice(0, 10);
    taskRows.push({
      tenantId,
      title: pick(TASK_TITLES),
      description: null,
      status,
      priority: pick(TASK_PRIORITIES_POOL),
      dueDate,
      assignedUserId: actor.id,
      createdBy: actor.id,
      completedAt,
      entityType: linkedDeal ? 'deal' : null,
      entityId: linkedDeal ? linkedDeal.id : null,
      createdAt: daysAgo(randInt(0, 30)),
      updatedAt: daysAgo(randInt(0, 14)),
    });
  }
  await db.insert(tasksTable).values(taskRows);
  // Activity rows for task creations (caps the noise — log only ~30%).
  const taskActivityRows: Array<typeof activityLogs.$inferInsert> = [];
  for (let i = 0; i < taskRows.length; i++) {
    if (Math.random() > 0.3) continue;
    const t = taskRows[i]!;
    taskActivityRows.push({
      tenantId,
      actorUserId: t.createdBy as string,
      entityType: 'task',
      entityId: crypto.randomUUID(), // can't reference real task id without returning(); use synthetic — feed renders fine
      action: 'created',
      metadata: {
        demoSeed: true,
        taskTitle: t.title,
        taskPriority: t.priority,
        actor: actorMeta(
          SEED_ACTORS.find((a) => a.id === t.createdBy) ?? SEED_ACTORS[0]!,
        ),
      },
      createdAt: t.createdAt as Date,
    });
  }
  if (taskActivityRows.length > 0) {
    await db.insert(activityLogs).values(taskActivityRows);
  }
  console.log(
    `  tasks     inserted: ${taskRows.length} in ${Date.now() - phase}ms`,
  );

  /* -------- NOTES -------- */

  phase = Date.now();
  const { notes: notesTable } = await import('../src/db/schema');
  const NOTE_BODIES = [
    'Spoke with the buyer — they want to see a clear ROI in the first 90 days. Sending a tailored ROI deck this week.',
    'Decision committee is forming. Champion looped in their VP of Engineering. Aim to align on technical fit by Friday.',
    'Held discovery call. Pain points: manual reporting, slow handoffs. Our automation story landed well.',
    'Pricing negotiation: they pushed back on the per-seat tier. Floated a flat enterprise rate; awaiting their counter.',
    'Procurement requires SOC2 docs before signature. Sent the latest report and audit summary.',
    'Customer concerned about migration time. Looped in solutions architect for a Tuesday walkthrough.',
    'Renewal looks stable. Champion is leaving in two months — need to introduce the new owner before then.',
    'Closed-won celebration on standup — kickoff scheduled for next Monday.',
    'Marked lost: chose a competitor due to existing partnership. Worth re-engaging in Q4 when their renewal hits.',
    'Slack thread with their security team confirmed we’re past compliance review.',
    'Held a 30-min syncon technical scope. They want our SAML integration before going live.',
    'CFO requested a multi-year discount. Floated a 2-year option at 12% off; awaiting board feedback.',
  ];
  // Distribute ~3 notes per won/lost deal + ~2 per active mid-funnel.
  const notesRows: Array<typeof notesTable.$inferInsert> = [];
  for (const d of insertedDeals) {
    const noteCount =
      d.stage === 'won' || d.stage === 'lost'
        ? randInt(2, 4)
        : d.stage === 'lead'
          ? randInt(0, 1)
          : randInt(1, 3);
    for (let i = 0; i < noteCount; i++) {
      const actor = pickActor();
      notesRows.push({
        tenantId,
        body: pick(NOTE_BODIES),
        authorUserId: actor.id,
        entityType: 'deal',
        entityId: d.id,
        createdAt: daysAgo(randInt(0, 60)),
      });
    }
  }
  if (notesRows.length > 0) {
    await db.insert(notesTable).values(notesRows);
  }
  console.log(
    `  notes     inserted: ${notesRows.length} in ${Date.now() - phase}ms`,
  );

  /* -------- NOTIFICATIONS -------- */

  phase = Date.now();
  const { notifications: notifTable } = await import('../src/db/schema');

  // Sample notifications addressed to one recipient persona — Priya
  // Sharma. In the running app, signing into Test 1 as a real Clerk
  // user wouldn't see these because RLS scopes to your own user id.
  // To see them light up, sign in with the matching id (or just look
  // at the table directly during dev).
  //
  // We seed a small mix so the dropdown reads naturally:
  //   - one unread task_assigned (recent)
  //   - one unread deal_won (today)
  //   - one read owner_changed (yesterday)
  //   - one unread task_due_soon (a few minutes ago)
  const RECIPIENT = 'seed-actor-priya-sharma';
  const ACTORS = [
    'seed-actor-rahul-mehta',
    'seed-actor-arjun-rao',
    'seed-actor-sarah-chen',
    'seed-actor-michael-torres',
  ];
  const sampleDeals = insertedDeals.slice(0, 6);
  const notifRows: Array<typeof notifTable.$inferInsert> = [];

  if (sampleDeals.length >= 4) {
    notifRows.push({
      tenantId,
      recipientUserId: RECIPIENT,
      actorUserId: ACTORS[0]!,
      type: 'task_assigned',
      title: `New task: Follow up on ${sampleDeals[0]!.name}`,
      subtitle: 'Due Friday',
      entityType: 'deal',
      entityId: sampleDeals[0]!.id,
      metadata: { priority: 'high' },
      createdAt: minutesAgo(18),
    });
    notifRows.push({
      tenantId,
      recipientUserId: RECIPIENT,
      actorUserId: null,
      type: 'task_due_soon',
      title: 'Task due tomorrow: Send Q3 proposal',
      subtitle: sampleDeals[1]!.name,
      entityType: 'deal',
      entityId: sampleDeals[1]!.id,
      metadata: {},
      createdAt: hoursAgo(2),
    });
    notifRows.push({
      tenantId,
      recipientUserId: RECIPIENT,
      actorUserId: ACTORS[1]!,
      type: 'deal_won',
      title: `Deal won: ${sampleDeals[2]!.name}`,
      subtitle: null,
      entityType: 'deal',
      entityId: sampleDeals[2]!.id,
      metadata: {},
      createdAt: hoursAgo(5),
    });
    notifRows.push({
      tenantId,
      recipientUserId: RECIPIENT,
      actorUserId: ACTORS[2]!,
      type: 'owner_changed',
      title: `You now own ${sampleDeals[3]!.name}`,
      subtitle: null,
      entityType: 'deal',
      entityId: sampleDeals[3]!.id,
      metadata: {},
      readAt: hoursAgo(22),
      createdAt: daysAgo(1),
    });
  }
  if (notifRows.length > 0) {
    await db.insert(notifTable).values(notifRows);
  }
  console.log(
    `  notifs    inserted: ${notifRows.length} in ${Date.now() - phase}ms`,
  );

  /* -------- COMMENTS -------- */

  phase = Date.now();
  const { comments: commentsTable } = await import('../src/db/schema');

  // Build a small thread per closed deal — a top-level observation
  // plus 1-2 replies, often with a mention to make the bell light up.
  const COMMENT_BODIES = [
    'Champion confirmed the budget — going to legal now.',
    'They pushed back on per-seat pricing; floating the enterprise tier.',
    'Need infosec sign-off before the kickoff. Looped in security.',
    'Owner intro went well. Schedule the next-step call this week.',
    'Procurement signed; expect PO by Friday.',
    'Lost on competitor partnership. Worth a revisit in Q4.',
  ];
  const REPLY_BODIES = [
    'Got it. {mention} can you join the call?',
    'Same here — let me know if you want a second pair of eyes.',
    'Already sent the security doc. Following up.',
    'Looped in {mention} on the doc.',
    'Same here. Going to close it out.',
  ];

  function buildMentionToken(actor: SeedActor): string {
    return `@[${actor.firstName} ${actor.lastName}](${actor.id})`;
  }

  const commentRows: Array<typeof commentsTable.$inferInsert> = [];
  // Maps optimistic top-level index → its assigned id so replies link.
  // We pre-generate uuids client-side so we can build the parent
  // chain without round-tripping a returning() per row.
  const closingDeals = insertedDeals.filter(
    (d) => d.stage === 'won' || d.stage === 'lost' || d.stage === 'negotiation',
  );
  for (const d of closingDeals) {
    if (Math.random() > 0.55) continue;
    const topAuthor = pickActor();
    const topId = crypto.randomUUID();
    commentRows.push({
      id: topId,
      tenantId,
      entityType: 'deal',
      entityId: d.id,
      authorUserId: topAuthor.id,
      parentCommentId: null,
      body: pick(COMMENT_BODIES),
      mentionedUserIds: [],
      createdAt: daysAgo(randInt(1, 40)),
    });

    // 50–80% chance to have a reply.
    if (Math.random() < 0.7) {
      const replyAuthor = pickActor();
      // Mentioning a third party — pick someone who isn't the author
      // or the top-level commenter so the mention reads naturally.
      const mentionTarget =
        SEED_ACTORS.find(
          (a) => a.id !== replyAuthor.id && a.id !== topAuthor.id,
        ) ?? SEED_ACTORS[0]!;
      const template = pick(REPLY_BODIES);
      const body = template.includes('{mention}')
        ? template.replace('{mention}', buildMentionToken(mentionTarget))
        : template;
      const mentions = body.includes('](') ? [mentionTarget.id] : [];
      commentRows.push({
        tenantId,
        entityType: 'deal',
        entityId: d.id,
        authorUserId: replyAuthor.id,
        parentCommentId: topId,
        body,
        mentionedUserIds: mentions,
        createdAt: daysAgo(randInt(0, 15)),
      });
    }
  }

  if (commentRows.length > 0) {
    await db.insert(commentsTable).values(commentRows);
  }
  console.log(
    `  comments  inserted: ${commentRows.length} in ${Date.now() - phase}ms`,
  );

  /* -------- EMAILS -------- */

  phase = Date.now();
  const { emailMessages: emailsTable } = await import('../src/db/schema');

  // Sample email history for a subset of mid-funnel + closed deals.
  // Mix of successful sends + one failed send so the timeline shows
  // both states. All recorded via the 'console' provider so it's
  // obviously synthetic; real Resend sends from the UI populate
  // 'provider=resend' rows.
  const EMAIL_SUBJECT_TEMPLATES = [
    'Following up on our last conversation',
    'Proposal — next steps',
    'Introducing ourselves',
    'Quick reminder',
    'Welcome — let’s kick off',
    'Q3 renewal — pricing options',
  ];
  const EMAIL_BODY_SAMPLES = [
    'Hi,\n\nThanks for the call yesterday. As discussed, attaching the proposal — happy to walk through it whenever works for you.\n\nBest,',
    'Hi,\n\nGreat to e-meet you! Wanted to introduce myself and share a quick overview of what we do, in case it’s relevant to your team.\n\nBest,',
    'Hi,\n\nFollowing up on this — would Tuesday at 10am work for a kickoff call?\n\nThanks,',
    'Hi,\n\nQuick reminder on the proposal — let me know if you have any questions before our next sync.\n\nThanks,',
  ];

  const emailRows: Array<typeof emailsTable.$inferInsert> = [];
  const emailActivityRows: Array<typeof activityLogs.$inferInsert> = [];
  const dealsForEmail = insertedDeals.filter(
    (d) =>
      d.stage === 'negotiation' ||
      d.stage === 'proposal' ||
      d.stage === 'won' ||
      d.stage === 'lost',
  );

  let failedOnce = false;
  for (const d of dealsForEmail) {
    if (Math.random() > 0.55) continue;
    const actor = pickActor();
    const subject = pick(EMAIL_SUBJECT_TEMPLATES);
    const body = pick(EMAIL_BODY_SAMPLES);
    const recipient = `contact-${d.id.slice(0, 8)}@example.com`;
    const createdAt = daysAgo(randInt(1, 30));
    const failed = !failedOnce && Math.random() < 0.08;
    if (failed) failedOnce = true;
    const emailId = crypto.randomUUID();

    emailRows.push({
      id: emailId,
      tenantId,
      actorUserId: actor.id,
      provider: 'console',
      direction: 'outbound',
      status: failed ? 'failed' : 'sent',
      subject,
      textBody: body,
      htmlBody: null,
      sender: 'CRM <onboarding@resend.dev>',
      toRecipients: [recipient],
      ccRecipients: [],
      bccRecipients: [],
      entityType: 'deal',
      entityId: d.id,
      providerMessageId: failed ? null : `console-seed-${emailId.slice(0, 8)}`,
      idempotencyKey: `seed-${emailId}`,
      error: failed ? 'Recipient address rejected by provider' : null,
      retryCount: failed ? 1 : 0,
      metadata: { seedDemo: true, source: 'seed' },
      sentAt: failed ? null : createdAt,
      failedAt: failed ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    });

    emailActivityRows.push({
      tenantId,
      actorUserId: actor.id,
      entityType: 'deal',
      entityId: d.id,
      action: failed ? 'email_failed' : 'email_sent',
      metadata: {
        demoSeed: true,
        emailId,
        subject,
        recipientLabel: recipient,
        provider: 'console',
        error: failed ? 'Recipient address rejected by provider' : undefined,
      },
      createdAt,
    });
  }

  if (emailRows.length > 0) {
    await db.insert(emailsTable).values(emailRows);
  }
  if (emailActivityRows.length > 0) {
    await db.insert(activityLogs).values(emailActivityRows);
  }
  console.log(
    `  emails    inserted: ${emailRows.length} in ${Date.now() - phase}ms`,
  );

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
  console.log(`    tasks:             ${taskRows.length}`);
  console.log(`    notes:             ${notesRows.length}`);
  console.log(`    notifications:     ${notifRows.length}`);
  console.log(`    comments:          ${commentRows.length}`);
  console.log(`    emails:            ${emailRows.length}`);
  console.log('\n  done.\n');

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed-demo fatal:', err);
  process.exit(1);
});
