import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Seed lead capture for one workspace (build prompt 1 deliverable):
 *   3 sales reps (users + member memberships, no password — they can't sign in
 *   until someone runs a password reset), routing profiles (IST working hours,
 *   skills, regions), 2 distribution rules (Maharashtra/Gujarat geo rule +
 *   workspace-default round robin), 1 webhook source and 1 published form.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/seed-lead-capture.ts <tenant-slug> [--use-existing-members]
 *
 * --use-existing-members puts the workspace's existing owner/admin/manager/
 * member users in the pools instead of creating demo reps.
 * Idempotent on the demo rep emails, source name and form slug.
 */
async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: seed-lead-capture.ts <tenant-slug> [--use-existing-members]');
    process.exit(2);
  }
  const useExisting = process.argv.includes('--use-existing-members');
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { and, eq } = await import('drizzle-orm');

  const [tenant] = (await db.execute(sql`select id, slug from tenants where slug = ${slug}`)) as unknown as Array<{ id: string; slug: string }>;
  if (!tenant) {
    console.error(`No workspace with slug "${slug}".`);
    process.exit(2);
  }

  let repIds: string[];
  if (useExisting) {
    const rows = (await db.execute(
      sql`select user_id from memberships where tenant_id = ${tenant.id} and status = 'active' and role <> 'viewer' order by created_at limit 3`,
    )) as unknown as Array<{ user_id: string }>;
    repIds = rows.map((r) => r.user_id);
    if (repIds.length === 0) throw new Error('No active members to use.');
  } else {
    const reps = [
      { first: 'Ananya', last: 'Kulkarni', skills: ['furnace', 'Marathi'], regions: ['Maharashtra', 'Pune', 'Mumbai'] },
      { first: 'Vikram', last: 'Patel', skills: ['crane', 'Gujarati'], regions: ['Gujarat', 'Ahmedabad'] },
      { first: 'Sneha', last: 'Reddy', skills: ['furnace', 'crane'], regions: ['Telangana', 'Karnataka'] },
    ];
    repIds = [];
    for (const [i, r] of reps.entries()) {
      const email = `lead-rep-${i + 1}+${tenant.slug}@example.com`.toLowerCase();
      const [u] = (await db.execute(sql`
        insert into users (id, email, first_name, last_name)
        values (${`usr_${randomBytes(10).toString('hex')}`}, ${email}, ${r.first}, ${r.last})
        on conflict (email) do update set first_name = excluded.first_name
        returning id`)) as unknown as Array<{ id: string }>;
      repIds.push(u!.id);
    }
    await runWithSystemContext(tenant.id, () =>
      tenantTransaction(async (tx) => {
        for (const userId of repIds) {
          await tx.insert(s.memberships).values({ tenantId: tenant.id, userId, role: 'member' }).onConflictDoNothing();
        }
        for (const [i, userId] of repIds.entries()) {
          const r = reps[i]!;
          await tx
            .insert(s.userRoutingProfile)
            .values({
              tenantId: tenant.id,
              userId,
              isAvailable: true,
              workingHours: {
                tz: 'Asia/Kolkata',
                days: { mon: ['09:30', '18:30'], tue: ['09:30', '18:30'], wed: ['09:30', '18:30'], thu: ['09:30', '18:30'], fri: ['09:30', '18:30'], sat: ['10:00', '14:00'] },
              },
              skills: r.skills,
              regions: r.regions,
            })
            .onConflictDoNothing();
        }
      }),
    );
  }

  const out = await runWithSystemContext(tenant.id, () =>
    tenantTransaction(async (tx) => {
      let [source] = await tx
        .select()
        .from(s.leadSources)
        .where(and(eq(s.leadSources.tenantId, tenant.id), eq(s.leadSources.name, 'Website enquiries (seed)')));
      if (!source) {
        [source] = await tx
          .insert(s.leadSources)
          .values({ tenantId: tenant.id, name: 'Website enquiries (seed)', type: 'webhook', secretToken: randomBytes(32).toString('hex') })
          .returning();
      }
      const existingRules = await tx.select({ name: s.distributionRules.name }).from(s.distributionRules).where(eq(s.distributionRules.tenantId, tenant.id));
      const hasDefault = (await tx.select({ id: s.distributionRules.id }).from(s.distributionRules).where(and(eq(s.distributionRules.tenantId, tenant.id), eq(s.distributionRules.isDefault, true)))).length > 0;
      if (!existingRules.some((r) => r.name === 'West India by region (seed)')) {
        await tx.insert(s.distributionRules).values({
          tenantId: tenant.id,
          name: 'West India by region (seed)',
          priority: 10,
          conditions: [{ field: 'state', op: 'in', value: ['Maharashtra', 'Gujarat'] }],
          strategy: 'geo_match',
          pool: { user_ids: repIds },
          slaMinutes: 30,
          maxReassignments: 2,
          capacityCap: 25,
        });
      }
      if (!existingRules.some((r) => r.name === 'Everyone else, round robin (seed)')) {
        await tx.insert(s.distributionRules).values({
          tenantId: tenant.id,
          name: 'Everyone else, round robin (seed)',
          priority: 100,
          strategy: 'round_robin',
          pool: { user_ids: repIds },
          slaMinutes: 60,
          maxReassignments: 1,
          isDefault: !hasDefault,
        });
      }
      await tx
        .insert(s.captureForms)
        .values({
          tenantId: tenant.id,
          sourceId: source!.id,
          slug: 'enquiry',
          title: 'Send us an enquiry',
          fields: [
            { key: 'name', label: 'Your name', type: 'text', required: true },
            { key: 'phone', label: 'Mobile number', type: 'tel', required: true },
            { key: 'email', label: 'Work email', type: 'email' },
            { key: 'company', label: 'Company', type: 'text' },
            { key: 'state', label: 'State', type: 'text' },
            { key: 'product', label: 'What are you looking for?', type: 'select', options: ['Induction furnace', 'EOT crane', 'Spares & service'] },
            { key: 'message', label: 'Requirement details', type: 'textarea' },
          ],
          thankYouMessage: 'Thank you — our team will call you shortly.',
          consentText: 'I agree to be contacted by phone, email or WhatsApp about my enquiry.',
          isPublished: true,
        })
        .onConflictDoNothing();
      return source!;
    }),
  );

  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  console.log('\nLead capture seeded.');
  console.log(`  reps:      ${repIds.join(', ')}`);
  console.log(`  endpoint:  ${base}/api/public/ingest/${out.id}`);
  console.log(`  secret:    ${out.secretToken}`);
  console.log(`  form page: ${base}/f/${tenant.slug}/enquiry`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
