import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

import { DEMO_TENANT_NAMES, isDemoTenant } from './demo-allowlist';

config({ path: '.env.local' });
config();

/**
 * Seeds ONE fully-populated "reference" deal — the canonical deal used for
 * demos and screenshots. Unlike `seed-demo-data.ts` (which floods a tenant
 * with ~80 deals), this writes a single, hand-shaped opportunity with every
 * detail-page widget populated so nothing renders an empty state:
 *
 *   - Company + primary/secondary stakeholders (deal_contacts)
 *   - Non-empty Competitor / Source / Next step
 *   - Relationship-health score (a "healthy" relationship_signals row)
 *   - 4 activity-log entries across types (call, meeting, email, note) + a note
 *   - 2 open tasks
 *   - Stage set to Negotiation with a stage-appropriate probability
 *
 * Tenant policy mirrors seed-demo-data.ts: it will ONLY write into a tenant
 * on the demo allowlist (scripts/demo-allowlist.ts). Every row is tagged
 * (customFields.referenceSeed / metadata.referenceSeed) so re-running cleanly
 * replaces the prior reference deal instead of piling up duplicates.
 *
 * Usage:
 *   pnpm seed:demo-deal                       // seeds the allowlisted tenant
 *   DEMO_TENANT_NAME="Test 1" pnpm seed:demo-deal
 *   TENANT_ID=<uuid> pnpm seed:demo-deal      // must still be on the allowlist
 */

const REFERENCE_TAG = 'referenceSeed';

// A seeded "team member" — deterministic id + display info stored on each
// activity row's metadata.actor so the timeline renders a name without a
// Clerk lookup (same convention as seed-demo-data.ts).
const ACTOR = {
  id: 'seed-actor-reference-deal',
  name: 'Priya Sharma',
  email: 'priya.sharma@test1.example',
  imageUrl: null as string | null,
};

function daysFromNow(d: number): Date {
  return new Date(Date.now() + d * 24 * 60 * 60 * 1000);
}
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const {
    companies,
    contacts,
    deals,
    dealContacts,
    activityLogs,
    tasks,
    notes,
    relationshipSignals,
    organizationSettings,
  } = await import('../src/db/schema');

  /* -------- resolve target tenant under the allowlist -------- */
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
      console.error('DEMO_TENANT_NAME is empty and the allowlist is empty.');
      process.exit(2);
    }
    const rows = (await db.execute(
      sql`SELECT id, name FROM tenants WHERE name = ${targetName} LIMIT 1`,
    )) as unknown as TenantLookup[];
    resolved = rows[0] ?? null;
    if (!resolved) {
      console.error(
        `No tenant named "${targetName}". Create the org and sign in once ` +
          `so the tenant row exists, then re-run.`,
      );
      process.exit(2);
    }
  }

  if (!isDemoTenant(resolved.name)) {
    console.error(
      `Refusing to seed tenant "${resolved.name}" — not on the demo ` +
        `allowlist (${DEMO_TENANT_NAMES.join(', ')}). Edit ` +
        `scripts/demo-allowlist.ts only if this is a real dev/test fixture.`,
    );
    process.exit(3);
  }

  const tenantId = resolved.id;
  console.log(`tenant="${resolved.name}" id=${tenantId}`);

  // Owner = the tenant's real owner/admin membership so the deal's "Owner"
  // field resolves to a real name. Fallback to the seed actor id.
  const ownerRows = (await db.execute(
    sql`SELECT user_id FROM memberships
        WHERE tenant_id = ${tenantId}::uuid AND status = 'active'
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'manager' THEN 2 ELSE 3 END
        LIMIT 1`,
  )) as unknown as { user_id: string }[];
  const ownerId = ownerRows[0]?.user_id ?? ACTOR.id;

  // Workspace currency so the reference deal renders in the same symbol as
  // every other deal (₹ for this deployment).
  const [settings] = await db
    .select({ defaultCurrency: organizationSettings.defaultCurrency })
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);
  const currency = settings?.defaultCurrency ?? 'INR';

  /* -------- reset any prior reference-seed rows -------- */
  // Deals / companies / contacts cascade to deal_contacts + deal_stage_history
  // + deal_documents via FK ON DELETE CASCADE. activity_logs / tasks / notes /
  // relationship_signals aren't FK-linked, so clear them by tag/entity first.
  const priorDeals = (await db.execute(
    sql`SELECT id FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND custom_fields->>'${sql.raw(REFERENCE_TAG)}' = 'true'`,
  )) as unknown as { id: string }[];
  for (const d of priorDeals) {
    await db.execute(
      sql`DELETE FROM activity_logs WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal' AND entity_id = ${d.id}`,
    );
    await db.execute(
      sql`DELETE FROM tasks WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal' AND entity_id = ${d.id}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM notes WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal' AND entity_id = ${d.id}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM relationship_signals WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal' AND entity_id = ${d.id}::uuid`,
    );
  }
  await db
    .delete(deals)
    .where(
      and(
        eq(deals.tenantId, tenantId),
        sql`${deals.customFields}->>'${sql.raw(REFERENCE_TAG)}' = 'true'`,
      ),
    );
  await db
    .delete(contacts)
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        sql`${contacts.customFields}->>'${sql.raw(REFERENCE_TAG)}' = 'true'`,
      ),
    );
  await db
    .delete(companies)
    .where(
      and(
        eq(companies.tenantId, tenantId),
        sql`${companies.customFields}->>'${sql.raw(REFERENCE_TAG)}' = 'true'`,
      ),
    );

  const tag = { [REFERENCE_TAG]: true } as Record<string, unknown>;

  /* -------- company -------- */
  const [company] = await db
    .insert(companies)
    .values({
      tenantId,
      name: 'Camlin Fine Sciences',
      domain: 'camlinfs.com',
      industry: 'Specialty Chemicals',
      ownerId,
      updatedBy: ownerId,
      customFields: tag,
    })
    .returning();
  if (!company) throw new Error('failed to insert reference company');

  /* -------- stakeholders (contacts) -------- */
  const [primaryContact] = await db
    .insert(contacts)
    .values({
      tenantId,
      companyId: company.id,
      firstName: 'Anand',
      lastName: 'Deshpande',
      email: 'anand.deshpande@camlinfs.com',
      phone: '+91 98200 11223',
      title: 'VP Procurement',
      ownerId,
      updatedBy: ownerId,
      customFields: tag,
    })
    .returning();
  const [secondaryContact] = await db
    .insert(contacts)
    .values({
      tenantId,
      companyId: company.id,
      firstName: 'Meera',
      lastName: 'Iyer',
      email: 'meera.iyer@camlinfs.com',
      phone: '+91 98670 44556',
      title: 'Plant Operations Lead',
      ownerId,
      updatedBy: ownerId,
      customFields: tag,
    })
    .returning();
  if (!primaryContact || !secondaryContact) {
    throw new Error('failed to insert reference contacts');
  }

  /* -------- the reference deal -------- */
  // ₹1,20,00,000 in minor units (INR has 2 decimals).
  const amountMinor = 12_000_000 * 100;
  const [deal] = await db
    .insert(deals)
    .values({
      tenantId,
      companyId: company.id,
      contactId: primaryContact.id,
      name: 'Camlin Fine Sciences — Antioxidant Supply Agreement',
      description:
        'Multi-year supply agreement for food-grade antioxidants across the ' +
        'Mumbai and Dahej plants. Displacing an incumbent; procurement is ' +
        'aligned, legal is the last gate.',
      stage: 'negotiation',
      amountMinor,
      marginBps: 3200,
      currency,
      probability: 80,
      competitor: 'Kemin Industries',
      source: 'Referral',
      nextStep:
        'Legal to finalize MSA redlines; target signature by month-end.',
      expectedCloseDate: ymd(daysFromNow(24)),
      ownerId,
      updatedBy: ownerId,
      customFields: tag,
    })
    .returning();
  if (!deal) throw new Error('failed to insert reference deal');

  /* -------- stakeholder links -------- */
  await db.insert(dealContacts).values([
    {
      tenantId,
      dealId: deal.id,
      contactId: primaryContact.id,
      role: 'decision_maker',
      isPrimary: true,
    },
    {
      tenantId,
      dealId: deal.id,
      contactId: secondaryContact.id,
      role: 'influencer',
      isPrimary: false,
    },
  ]);

  /* -------- activity log (4 entries across types) -------- */
  const actorMeta = { name: ACTOR.name, email: ACTOR.email, imageUrl: ACTOR.imageUrl };
  await db.insert(activityLogs).values([
    {
      tenantId,
      actorUserId: ACTOR.id,
      entityType: 'deal',
      entityId: deal.id,
      action: 'created',
      metadata: { name: deal.name, stage: 'lead', actor: actorMeta, [REFERENCE_TAG]: true },
      createdAt: daysAgo(21),
    },
    {
      tenantId,
      actorUserId: ACTOR.id,
      entityType: 'deal',
      entityId: deal.id,
      action: 'call_logged',
      metadata: {
        name: deal.name,
        message:
          'Intro call with procurement — confirmed annual volume ~1,800 MT and ' +
          'a Q3 changeover window.',
        actor: actorMeta,
        [REFERENCE_TAG]: true,
      },
      createdAt: daysAgo(14),
    },
    {
      tenantId,
      actorUserId: ACTOR.id,
      entityType: 'deal',
      entityId: deal.id,
      action: 'meeting_logged',
      metadata: {
        name: deal.name,
        message:
          'On-site plant visit at Dahej — walked the line, reviewed spec sheet ' +
          'and QA requirements with operations.',
        actor: actorMeta,
        [REFERENCE_TAG]: true,
      },
      createdAt: daysAgo(7),
    },
    {
      tenantId,
      actorUserId: ACTOR.id,
      entityType: 'deal',
      entityId: deal.id,
      action: 'email_sent',
      metadata: {
        name: deal.name,
        message: 'Sent the revised commercial proposal + draft MSA for legal review.',
        actor: actorMeta,
        [REFERENCE_TAG]: true,
      },
      createdAt: daysAgo(2),
    },
  ]);

  /* -------- a human note -------- */
  await db.insert(notes).values({
    tenantId,
    body:
      'Champion (Anand) is pushing internally for a month-end signature to lock ' +
      'in this quarter. Main open item is the liability cap in the MSA — legal ' +
      'reviewing. Kemin is the incumbent but pricing is no longer competitive.',
    authorUserId: ACTOR.id,
    entityType: 'deal',
    entityId: deal.id,
    createdAt: daysAgo(2),
  });

  /* -------- open tasks -------- */
  await db.insert(tasks).values([
    {
      tenantId,
      title: 'Get legal sign-off on MSA liability cap',
      description: 'Blocking signature. Chase in-house counsel for redlines.',
      status: 'todo',
      priority: 'high',
      type: 'internal',
      stageBlocking: 'negotiation',
      dueDate: ymd(daysFromNow(3)),
      assignedUserId: ownerId,
      createdBy: ownerId,
      entityType: 'deal',
      entityId: deal.id,
    },
    {
      tenantId,
      title: 'Schedule signature call with procurement',
      description: 'Once MSA is clean, book the closing call with Anand.',
      status: 'todo',
      priority: 'medium',
      type: 'call',
      dueDate: ymd(daysFromNow(10)),
      assignedUserId: ownerId,
      createdBy: ownerId,
      entityType: 'deal',
      entityId: deal.id,
    },
  ]);

  /* -------- relationship health (a healthy signal row) -------- */
  await db.insert(relationshipSignals).values({
    tenantId,
    entityType: 'deal',
    entityId: deal.id,
    lastInboundAt: daysAgo(1),
    lastOutboundAt: daysAgo(2),
    totalInbound: 8,
    totalOutbound: 9,
    unansweredCount: 1,
    avgResponseHours: 6.4,
    silentDays: 1,
    score: 0.85,
    status: 'healthy',
  });

  console.log(`✓ reference deal seeded: ${deal.name}`);
  console.log(`  /dashboard/deals/${deal.id}`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed-demo-deal fatal:', err);
  process.exit(1);
});
