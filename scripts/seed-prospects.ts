import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Seeds 30 prospects (3 source tags x 10) into one tenant of a LOCAL/test DB.
 *
 *   pnpm seed:prospects -- --tenant <slug-or-id> [--reset]
 *
 * Refuses unless DATABASE_URL contains ":15434" or SEED_ALLOW_REMOTE=1.
 */

const SOURCES = ['Trade show 2026', 'LinkedIn', 'Referral'] as const;
const STAGE_PLAN = [
  ...Array(10).fill('dump'),
  ...Array(8).fill('researching'),
  ...Array(6).fill('qualified'),
  ...Array(4).fill('ready'),
  ...Array(2).fill('parked'),
] as Array<'dump' | 'researching' | 'qualified' | 'ready' | 'parked'>;

type Row = {
  name: string; domain: string; contact: string; role: string; industry: string | null;
  size: '1-10' | '11-50' | '51-200' | '201-1000' | '1000+'; city: string; state: string | null; tags: string[];
};
const COMPANIES: Row[] = [
  { name: 'Shreeji Textiles Pvt Ltd', domain: 'shreejitextiles.in', contact: 'Rakesh Shah', role: 'Director', industry: 'Textiles', size: '201-1000', city: 'Surat', state: 'Gujarat', tags: ['manufacturing'] },
  { name: 'Bharat Auto Components', domain: 'bharatautocomp.in', contact: 'Sunil Patil', role: 'GM Operations', industry: 'Automotive', size: '201-1000', city: 'Pune', state: 'Maharashtra', tags: ['manufacturing', 'tier-2'] },
  { name: 'Kaveri Agro Foods', domain: 'kaveriagro.in', contact: 'Lakshmi Narayanan', role: 'CEO', industry: 'Food Processing', size: '51-200', city: 'Coimbatore', state: 'Tamil Nadu', tags: ['agri'] },
  { name: 'Deccan Logistics Solutions', domain: 'deccanlogistics.in', contact: 'Imran Qureshi', role: 'VP Sales', industry: 'Logistics', size: '51-200', city: 'Hyderabad', state: 'Telangana', tags: ['logistics'] },
  { name: 'Himalaya Pharma Labs', domain: 'himalayapharmalabs.com', contact: 'Neha Kapoor', role: 'Head of Procurement', industry: 'Pharmaceuticals', size: '201-1000', city: 'Baddi', state: 'Himachal Pradesh', tags: ['pharma'] },
  { name: 'Sagar Marine Exports', domain: 'sagarmarine.in', contact: 'Joseph Fernandes', role: 'Managing Partner', industry: 'Seafood Exports', size: '11-50', city: 'Kochi', state: 'Kerala', tags: ['export'] },
  { name: 'Nalanda EdTech', domain: 'nalandaedtech.com', contact: 'Ankit Sinha', role: 'Founder', industry: 'Education', size: '11-50', city: 'Patna', state: 'Bihar', tags: ['startup'] },
  { name: 'Rajputana Steel Works', domain: 'rajputanasteel.in', contact: 'Vikram Rathore', role: 'Purchase Manager', industry: 'Steel', size: '201-1000', city: 'Jaipur', state: 'Rajasthan', tags: ['manufacturing'] },
  { name: 'Mahanadi Power Systems', domain: 'mahanadipower.in', contact: 'Subrat Mohanty', role: 'CTO', industry: 'Energy', size: '51-200', city: 'Bhubaneswar', state: 'Odisha', tags: ['energy'] },
  { name: 'Vaishnavi Realty Developers', domain: 'vaishnavirealty.in', contact: 'Pooja Deshmukh', role: 'Director', industry: 'Real Estate', size: '51-200', city: 'Nagpur', state: 'Maharashtra', tags: ['realty'] },
  { name: 'Ganga Plastics Industries', domain: 'gangaplastics.in', contact: 'Manoj Agarwal', role: 'Owner', industry: 'Plastics', size: '51-200', city: 'Kanpur', state: 'Uttar Pradesh', tags: ['manufacturing'] },
  { name: 'Silicon Valley Infosys Services', domain: 'svinfosys.in', contact: 'Karthik Reddy', role: 'Head IT', industry: 'IT Services', size: '1000+', city: 'Bengaluru', state: 'Karnataka', tags: ['it', 'enterprise'] },
  { name: 'Punjab Dairy Co-op', domain: 'punjabdairycoop.in', contact: 'Harpreet Gill', role: 'General Manager', industry: 'Dairy', size: '1000+', city: 'Ludhiana', state: 'Punjab', tags: ['agri', 'enterprise'] },
  { name: 'Konkan Cashew Traders', domain: 'konkancashew.in', contact: 'Sanjay Naik', role: 'Proprietor', industry: 'Agri Trading', size: '1-10', city: 'Panaji', state: 'Goa', tags: ['agri', 'export'] },
  { name: 'Aravali Cement Ltd', domain: 'aravalicement.com', contact: 'Rohit Bansal', role: 'Plant Head', industry: 'Cement', size: '1000+', city: 'Udaipur', state: 'Rajasthan', tags: ['enterprise'] },
  { name: 'Brahmaputra Tea Estates', domain: 'brahmaputratea.in', contact: 'Dipankar Baruah', role: 'Manager', industry: 'Tea', size: '201-1000', city: 'Guwahati', state: 'Assam', tags: ['agri'] },
  { name: 'Metro Medical Devices', domain: 'metromeddev.in', contact: 'Farah Khan', role: 'Business Head', industry: 'Medical Devices', size: '51-200', city: 'Mumbai', state: 'Maharashtra', tags: ['healthcare'] },
  { name: 'Tirupati Packaging', domain: 'tirupatipack.in', contact: 'Venkatesh Rao', role: 'Director', industry: 'Packaging', size: '11-50', city: 'Vijayawada', state: 'Andhra Pradesh', tags: ['manufacturing'] },
  { name: 'Lotus Hospitality Group', domain: 'lotushospitality.in', contact: 'Meera Iyer', role: 'COO', industry: 'Hospitality', size: '201-1000', city: 'Chennai', state: 'Tamil Nadu', tags: ['hospitality'] },
  { name: 'Narmada Chemicals', domain: 'narmadachem.in', contact: 'Hitesh Modi', role: 'Director', industry: 'Chemicals', size: '51-200', city: 'Vadodara', state: 'Gujarat', tags: ['manufacturing'] },
  { name: 'Capital Retail Mart', domain: 'capitalretailmart.in', contact: 'Gaurav Malhotra', role: 'Head Purchase', industry: 'Retail', size: '201-1000', city: 'Gurugram', state: 'Haryana', tags: ['retail'] },
  { name: 'Sundarban Handicrafts', domain: 'sundarbancrafts.in', contact: 'Soumya Banerjee', role: 'Founder', industry: null, size: '1-10', city: 'Kolkata', state: 'West Bengal', tags: ['startup'] },
  { name: 'Malwa Engineering Works', domain: 'malwaengg.in', contact: 'Deepak Joshi', role: 'Owner', industry: 'Engineering', size: '11-50', city: 'Indore', state: null, tags: ['manufacturing'] },
  { name: 'Orion Cold Chain', domain: 'orioncoldchain.in', contact: 'Tanvi Mehta', role: 'VP Operations', industry: 'Logistics', size: '51-200', city: 'Ahmedabad', state: 'Gujarat', tags: ['logistics'] },
  { name: 'Zenith Solar Energy', domain: 'zenithsolar.in', contact: 'Arjun Nair', role: 'CEO', industry: 'Renewable Energy', size: '51-200', city: 'Thiruvananthapuram', state: 'Kerala', tags: ['energy', 'startup'] },
  { name: 'Doon Valley Biotech', domain: 'doonbiotech.in', contact: 'Ritu Sharma', role: 'Director R&D', industry: null, size: '11-50', city: 'Dehradun', state: null, tags: ['pharma'] },
  { name: 'Kalinga Mining Services', domain: 'kalingamining.in', contact: 'Prasanta Das', role: 'GM', industry: 'Mining', size: '201-1000', city: 'Rourkela', state: 'Odisha', tags: ['enterprise'] },
  { name: 'Awadh Garments', domain: 'awadhgarments.in', contact: 'Zeeshan Ansari', role: 'Partner', industry: 'Apparel', size: '51-200', city: 'Lucknow', state: 'Uttar Pradesh', tags: ['manufacturing', 'export'] },
  { name: 'Western Ghats Spices', domain: 'wgspices.in', contact: 'Thomas Mathew', role: 'MD', industry: 'Spices', size: '11-50', city: 'Idukki', state: 'Kerala', tags: ['agri', 'export'] },
  { name: 'Vindhya Paper Mills', domain: 'vindhyapaper.in', contact: 'Alok Tiwari', role: 'Director', industry: 'Paper', size: '201-1000', city: 'Bhopal', state: 'Madhya Pradesh', tags: ['manufacturing'] },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const tenantArg = arg('tenant');
  const reset = process.argv.includes('--reset');
  if (!tenantArg || tenantArg.startsWith('--')) {
    console.error('Usage: pnpm seed:prospects -- --tenant <slug-or-id> [--reset]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes(':15434') && process.env.SEED_ALLOW_REMOTE !== '1') {
    console.error('Refusing to seed: DATABASE_URL is not the local test DB (:15434). Set SEED_ALLOW_REMOTE=1 to override.');
    process.exit(1);
  }
  let host = '(unparseable)';
  try { host = new URL(url).host; } catch { /* keep placeholder */ }
  console.log(`Using DB host: ${host}`);

  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, runWithTenantContext, tenantTransaction } = await import('../src/lib/db-context');
  const m = await import('../src/lib/prospects/mutations');
  const { and, eq, inArray } = await import('drizzle-orm');

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantArg);
    const trows = (await db.execute(
      isUuid ? sql`SELECT id, slug FROM tenants WHERE id = ${tenantArg}` : sql`SELECT id, slug FROM tenants WHERE slug = ${tenantArg}`,
    )) as unknown as Array<{ id: string; slug: string }>;
    const tenant = trows[0];
    if (!tenant) throw new Error(`Tenant not found: ${tenantArg}`);
    const tenantId = tenant.id;
    console.log(`Tenant: ${tenant.slug} (${tenantId})`);

    const inTenant = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
      runWithSystemContext(tenantId, () => tenantTransaction(fn as never)) as Promise<T>;

    const members = await inTenant((tx) =>
      tx.select({ userId: s.memberships.userId, role: s.memberships.role }).from(s.memberships)
        .where(and(eq(s.memberships.tenantId, tenantId), eq(s.memberships.status, 'active'))),
    );
    if (members.length === 0) throw new Error('Tenant has no active members');
    const actorRow = members.find((x) => ['owner', 'admin', 'manager'].includes(x.role)) ?? members[0]!;
    const actor = { userId: actorRow.userId, role: actorRow.role };
    const claimers = [...members].sort((a, b) => Number(b.role === 'member') - Number(a.role === 'member'));

    const existing = await inTenant((tx) =>
      tx.select({ id: s.prospects.id }).from(s.prospects)
        .where(and(eq(s.prospects.tenantId, tenantId), inArray(s.prospects.sourceTag, [...SOURCES]))),
    );
    if (existing.length > 0) {
      if (!reset) {
        console.error(`Tenant already has ${existing.length} seed prospects. Re-run with --reset to replace them.`);
        process.exitCode = 1;
        return;
      }
      // Comments are not FK-cascaded from prospects, so remove the seeded ones first.
      await inTenant((tx) =>
        tx.delete(s.comments).where(and(
          eq(s.comments.tenantId, tenantId),
          eq(s.comments.entityType, 'prospect'),
          inArray(s.comments.entityId, existing.map((e) => e.id)),
        )),
      );
      await inTenant((tx) =>
        tx.delete(s.prospects).where(and(eq(s.prospects.tenantId, tenantId), inArray(s.prospects.sourceTag, [...SOURCES]))),
      );
      console.log(`Reset: deleted ${existing.length} seed prospects`);
    }

    const offerings = await inTenant((tx) =>
      tx.select({ id: s.offerings.id }).from(s.offerings)
        .where(and(eq(s.offerings.tenantId, tenantId), eq(s.offerings.active, true))),
    );

    const asActor = <T,>(fn: () => Promise<T>) => runWithTenantContext({ tenantId, userId: actor.userId }, fn);
    const path: Record<string, string[]> = {
      dump: [], researching: ['researching'], qualified: ['researching', 'qualified'],
      ready: ['researching', 'qualified', 'ready'], parked: ['parked'],
    };
    // Company i gets source i%3, stage STAGE_PLAN[i]: every source sees a mix of stages.
    const created: Array<{ id: string; stage: string }> = [];
    for (let i = 0; i < 30; i++) {
      const c = COMPANIES[i]!;
      const r = await asActor(() => m.createProspect(tenantId, actor as never, {
        companyName: c.name, domain: c.domain, contactName: c.contact, contactDesignation: c.role,
        contactEmail: `${c.contact.split(' ').pop()!.toLowerCase().replace(/[^a-z]/g, '')}@${c.domain}`,
        contactPhone: `+91 98${String(10000000 + i * 137913).slice(0, 8)}`,
        industry: c.industry, sizeBand: c.size, city: c.city, state: c.state,
        productFitOfferingId: offerings.length ? offerings[i % offerings.length]!.id : null,
        icpScore: 35 + ((i * 17) % 60), clusterTags: c.tags, sourceTag: SOURCES[i % 3]!,
        notes: i % 4 === 0 ? `Met ${c.contact}; follow up on requirements.` : null,
      } as never));
      if (!r.ok) throw new Error(`create ${c.name} failed: ${r.error}`);
      const stage = STAGE_PLAN[i]!;
      for (const to of path[stage]!) {
        const mv = await asActor(() => m.moveProspectStage(tenantId, actor as never, r.id, to as never));
        if (!mv.ok) throw new Error(`move ${c.name} -> ${to} failed: ${mv.error}`);
      }
      created.push({ id: r.id, stage });
    }

    // Claims (8, non-parked, spread over members) and votes (12), after stage moves.
    const claimable = created.filter((x) => x.stage !== 'parked').filter((_, i) => i % 3 === 0).slice(0, 8);
    const now = Date.now();
    const votable = created.filter((_, i) => i % 5 < 2).slice(0, 12);
    await inTenant(async (tx) => {
      for (let i = 0; i < claimable.length; i++) {
        const u = claimers[i % claimers.length]!.userId;
        await tx.update(s.prospects).set({
          claimedBy: u, claimedAt: new Date(now), claimExpiresAt: new Date(now + 14 * 86400000),
        }).where(eq(s.prospects.id, claimable[i]!.id));
      }
      for (let i = 0; i < votable.length; i++) {
        const rows = members.slice(0, 1 + (i % members.length)).map((mem, j) => ({
          tenantId, prospectId: votable[i]!.id, userId: mem.userId,
          kind: ((i + j) % 3 === 0 ? 'know_someone' : 'priority') as 'know_someone' | 'priority',
        }));
        await tx.insert(s.prospectVotes).values(rows).onConflictDoNothing();
      }
    });

    // Comments: 2-3 on about 5 prospects; one per prospect mentions another member.
    const names = await inTenant((tx) =>
      tx.select({ id: s.users.id, first: s.users.firstName, last: s.users.lastName }).from(s.users)
        .where(inArray(s.users.id, members.map((x) => x.userId))),
    );
    const nameOf = (uid: string) => {
      const u = names.find((n) => n.id === uid);
      return [u?.first, u?.last].filter(Boolean).join(' ').trim() || 'Teammate';
    };
    const SNIPPETS = [
      'Spoke to their procurement team, looks promising.',
      'Decision maker confirmed; needs a demo next week.',
      'Budget cycle starts in Q1, worth keeping warm.',
    ];
    const commented = created.filter((_, i) => i % 6 === 1).slice(0, 5);
    const commentRows: Array<typeof s.comments.$inferInsert> = [];
    commented.forEach((pr, i) => {
      const n = 2 + (i % 2);
      for (let k = 0; k < n; k++) {
        const author = members[(i + k) % members.length]!.userId;
        const peer = members.find((x) => x.userId !== author);
        const mention = k === 0 && peer ? ` @[${nameOf(peer.userId)}](${peer.userId}) can you take a look?` : '';
        commentRows.push({
          tenantId, entityType: 'prospect', entityId: pr.id, authorUserId: author,
          body: `${SNIPPETS[(i + k) % SNIPPETS.length]}${mention}`,
          mentionedUserIds: mention && peer ? [peer.userId] : [],
          createdAt: new Date(now - (n - k) * 3_600_000 * (i + 1)),
        });
      }
    });
    await inTenant((tx) => tx.insert(s.comments).values(commentRows));

    console.log(`Seeded ${created.length} prospects, ${claimable.length} claimed, ${votable.length} with votes, ${commentRows.length} comments on ${commented.length} prospects.`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed fatal:', err);
  process.exit(1);
});
