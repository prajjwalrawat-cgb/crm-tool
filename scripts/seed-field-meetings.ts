import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// Seeded companies carry pinned coordinates, so nothing here needs Google, and nothing here
// may reach Google or Claude (a real key in .env.local must not be used by a seed).
process.env.MAPS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

/**
 * Seeds two Field Meetings tenants into a LOCAL/test DB, each with 1 manager, 3 reps,
 * 3 pinned company sites and 3 meetings per rep for "today" (tenant time zone), then
 * runs the risk scan once so the Field day board shows flags straight away.
 *
 *   pnpm seed:field [--reset]
 *
 *   field-askmira   location provider 'askmira'
 *   field-solo      location provider 'none'
 *
 * Meeting times are relative to the moment the script runs, so re-run with --reset on
 * another day (or hour) to refresh them. Refuses unless DATABASE_URL contains ":15434"
 * or SEED_ALLOW_REMOTE=1. --reset removes only the two seed tenants and their users.
 */

const TENANTS = [
  { slug: 'field-askmira', name: 'Field Ask Mira', provider: 'askmira' as const },
  { slug: 'field-solo', name: 'Field Solo', provider: 'none' as const },
];
const PASSWORD = 'Test@12345';
const DEFAULT_TZ = 'Asia/Kolkata';

const SITES = {
  noida: { name: 'Noida Sec 62 Plant', address: 'Sector 62', city: 'Noida', state: 'Uttar Pradesh', postalCode: '201309', lat: 28.627, lng: 77.3727 },
  gurugram: { name: 'Cyber City Gurugram HQ', address: 'DLF Cyber City', city: 'Gurugram', state: 'Haryana', postalCode: '122002', lat: 28.495, lng: 77.0895 },
  okhla: { name: 'Okhla Ph III Works', address: 'Okhla Phase III', city: 'New Delhi', state: 'Delhi', postalCode: '110020', lat: 28.5494, lng: 77.2736 },
} as const;
type SiteKey = keyof typeof SITES;

/** Minutes from the run time. All three reps get 3 meetings; see the comment per rep. */
type Slot = { site: SiteKey; title: string; startMin: number; endMin: number; deal?: 'shared' | 'own' };
const PLAN: Record<'rep1' | 'rep2' | 'rep3', Slot[]> = {
  // Overlap: first two meetings share a window. The third is far enough out to be clean.
  rep1: [
    { site: 'noida', title: 'Plant walkthrough', startMin: 60, endMin: 120, deal: 'shared' },
    { site: 'noida', title: 'Pricing review', startMin: 90, endMin: 150, deal: 'shared' },
    { site: 'okhla', title: 'Site survey', startMin: 220, endMin: 250 },
  ],
  // Tight travel: Noida -> Gurugram with a 20 minute gap (a drive is well over an hour).
  rep2: [
    { site: 'noida', title: 'Kick-off call on site', startMin: 60, endMin: 120, deal: 'own' },
    { site: 'gurugram', title: 'Executive briefing', startMin: 140, endMin: 200 },
    { site: 'okhla', title: 'Follow-up visit', startMin: 290, endMin: 320 },
  ],
  // No check-in: the first meeting started 30 min ago (past the 15 min grace) and was never checked in.
  rep3: [
    { site: 'gurugram', title: 'Contract signing', startMin: -30, endMin: 30 },
    { site: 'okhla', title: 'Demo at works', startMin: 110, endMin: 160, deal: 'own' },
    { site: 'noida', title: 'Installation check', startMin: 230, endMin: 260 },
  ],
};

function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

async function main() {
  const reset = process.argv.includes('--reset');
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes(':15434') && process.env.SEED_ALLOW_REMOTE !== '1') {
    console.error('Refusing to seed: DATABASE_URL is not the local test DB (:15434). Set SEED_ALLOW_REMOTE=1 to override.');
    process.exit(1);
  }
  let host = '(unparseable)';
  try {
    host = new URL(url).host;
  } catch {
    /* keep placeholder */
  }
  console.log(`Using DB host: ${host}`);

  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { hashPassword } = await import('../src/lib/auth/password');
  const { createMeeting } = await import('../src/lib/field/meetings');
  const { scanTenantRisks } = await import('../src/lib/field/risk-scan');
  const { inArray } = await import('drizzle-orm');
  type FieldActor = import('../src/lib/field/types').FieldActor;

  const slugs = TENANTS.map((t) => t.slug);
  const userPrefix = (slug: string) => `usr_field_${slug.replace(/^field-/, '')}_`;
  const logins: string[] = [];

  try {
    if (reset) {
      // Tenant delete cascades memberships, meetings, companies, deals, notifications and caches.
      // meetings.owner_id has no ON DELETE, so users go last.
      await db.execute(sql`DELETE FROM tenants WHERE slug IN (${sql.join(slugs.map((x) => sql`${x}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM users WHERE id LIKE ${'usr\\_field\\_%'}`);
      console.log('Reset: removed field-askmira and field-solo.');
    }

    const passwordHash = await hashPassword(PASSWORD);
    const runAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const at = (min: number) => new Date(runAt.getTime() + min * 60_000);
    const inT = <T,>(tenantId: string, fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
      runWithSystemContext(tenantId, () => tenantTransaction(fn as never)) as Promise<T>;

    for (const t of TENANTS) {
      const existing = (await db.execute(sql`SELECT id FROM tenants WHERE slug = ${t.slug}`)) as unknown as Array<{ id: string }>;
      const uid = (k: string) => `${userPrefix(t.slug)}${k}`;
      const email = (k: string) => `${k}@${t.slug}.test`;
      const people = [
        { key: 'mgr', first: 'Manager', last: t.slug === 'field-solo' ? 'Solo' : 'Mira', role: 'manager' as const },
        { key: 'rep1', first: 'Rep One', last: t.slug === 'field-solo' ? 'Solo' : 'Mira', role: 'member' as const },
        { key: 'rep2', first: 'Rep Two', last: t.slug === 'field-solo' ? 'Solo' : 'Mira', role: 'member' as const },
        { key: 'rep3', first: 'Rep Three', last: t.slug === 'field-solo' ? 'Solo' : 'Mira', role: 'member' as const },
      ];
      for (const p of people) logins.push(`${t.slug}: ${email(p.key)} / ${PASSWORD} (${p.role})`);

      if (existing[0]) {
        console.log(`${t.slug}: already seeded (meeting times are stale). Re-run with --reset to refresh.`);
        continue;
      }

      const [tenant] = await db.insert(s.tenants).values({ name: t.name, slug: t.slug }).returning({ id: s.tenants.id });
      const tenantId = tenant!.id;

      // Tenant time zone: organization_settings is the source of truth; no row means the default.
      const tz = DEFAULT_TZ;
      const today = localDate(runAt, tz);
      const lastMin = Math.max(...Object.values(PLAN).flat().map((x) => x.endMin));
      const firstMin = Math.min(...Object.values(PLAN).flat().map((x) => x.startMin));
      if (localDate(at(lastMin), tz) !== today || localDate(at(firstMin), tz) !== today) {
        throw new Error(
          `Too close to midnight in ${tz}: the seeded day needs ${firstMin} to +${lastMin} minutes around now to stay on ${today}. Re-run earlier or later in the day.`,
        );
      }

      await db.insert(s.tenantFieldSettings).values({ tenantId, locationProvider: t.provider });

      await db.insert(s.users).values(
        people.map((p) => ({
          id: uid(p.key),
          email: email(p.key),
          passwordHash,
          emailVerified: true,
          firstName: p.first,
          lastName: p.last,
        })),
      );
      await db.insert(s.memberships).values(
        people.map((p) => ({
          tenantId,
          userId: uid(p.key),
          role: p.role,
          reportsToUserId: p.key === 'mgr' ? null : uid('mgr'),
        })),
      );

      const companyIds = {} as Record<SiteKey, string>;
      for (const key of Object.keys(SITES) as SiteKey[]) {
        const { name, ...site } = SITES[key];
        const [row] = await db
          .insert(s.companies)
          .values({ tenantId, name, ...site, geocodeStatus: 'manual' })
          .returning({ id: s.companies.id });
        companyIds[key] = row!.id;
      }

      const dealFor = async (name: string, companyKey: SiteKey, ownerKey: string) => {
        const [row] = await db
          .insert(s.deals)
          .values({ tenantId, name, amountMinor: 2_500_000, currency: 'INR', companyId: companyIds[companyKey], ownerId: uid(ownerKey) })
          .returning({ id: s.deals.id });
        return row!.id;
      };
      const dealIds: Partial<Record<'rep1' | 'rep2' | 'rep3', string>> = {
        rep1: await dealFor('Noida plant expansion', 'noida', 'rep1'), // linked to two of rep1's meetings
        rep2: await dealFor('Noida line upgrade', 'noida', 'rep2'),
        rep3: await dealFor('Okhla works retrofit', 'okhla', 'rep3'),
      };

      const meetingIds: string[] = [];
      for (const key of ['rep1', 'rep2', 'rep3'] as const) {
        const actor: FieldActor = { tenantId, userId: uid(key), role: 'member' };
        for (const slot of PLAN[key]) {
          const m = await createMeeting(
            actor,
            {
              title: slot.title,
              type: 'physical',
              startAt: at(slot.startMin),
              endAt: at(slot.endMin),
              companyId: companyIds[slot.site],
              dealId: slot.deal ? dealIds[key]! : null,
            },
            { now: () => runAt },
          );
          meetingIds.push(m.id);
        }
      }

      // The scan only looks at "now": run it for the seed's own time and skip the tracking-hours gate.
      const scan = await scanTenantRisks(tenantId, { ignoreHours: true, now: () => runAt });
      console.log(`${t.slug}: ${meetingIds.length} meetings for ${today} (${tz}); scan ${JSON.stringify(scan)}`);

      const rows = await inT(tenantId, (tx) =>
        tx
          .select({ title: s.meetings.title, ownerId: s.meetings.ownerId, startAt: s.meetings.startAt, reasons: s.meetings.atRiskReasons })
          .from(s.meetings)
          .where(inArray(s.meetings.id, meetingIds)),
      );
      const who = new Map(people.map((p) => [uid(p.key), p.key]));
      rows.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      for (const r of rows) {
        const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(r.startAt);
        console.log(`  ${who.get(r.ownerId)} ${hm} ${r.title.padEnd(24)} flags: ${r.reasons.length ? r.reasons.join(', ') : '-'}`);
      }
    }

    console.log('\nLogins:');
    for (const l of logins) console.log(`  ${l}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
