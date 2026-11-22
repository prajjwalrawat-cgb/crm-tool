import { can } from '../src/lib/rbac';
import {
  groupKeyOf,
  normalizeProspectInput,
  editBlock,
  claimBlock,
  releaseBlock,
  parseProspectFilters,
  prospectInputSchema,
  stageMoveBlock,
  type ProspectCard,
} from '../src/lib/prospects/rules';

/**
 * Pure self-test for the Prospect Board rules (no DB).
 *   tsx scripts/selftest-prospects.ts
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

const base = { companyName: 'Acme Pvt Ltd', sourceTag: 'expo' };
const parse = (extra: Record<string, unknown>) => prospectInputSchema.safeParse({ ...base, ...extra });

check('input: blank company rejected', prospectInputSchema.safeParse({ companyName: '   ', sourceTag: 'x' }).success === false);
{
  const r = parse({ clusterTags: [' SaaS', 'saas', 'Pune ', ''] });
  check('input: tags cleaned', r.success && JSON.stringify(r.data.clusterTags) === '["saas","pune"]', r.success ? r.data.clusterTags : r.error.issues);
  const many = parse({ clusterTags: Array.from({ length: 25 }, (_, i) => `t${i}`) });
  check('input: 25 tags capped at 20', many.success && many.data.clusterTags.length === 20);
  check('input: 60-char tag rejected', parse({ clusterTags: ['a'.repeat(60)] }).success === false);
  const e = parse({ contactEmail: '' });
  check('input: empty string -> null', e.success && e.data.contactEmail === null, e.success ? e.data.contactEmail : e.error.issues);
}
{
  const r = parse({ contactPhone: '098765 43210', domain: 'https://www.Acme.com/about', contactEmail: ' Foo@Acme.COM ' });
  if (!r.success) check('normalize: parse', false, r.error.issues);
  else {
    const v = normalizeProspectInput(r.data);
    check('normalize: phone', v.phoneNormalized === '+919876543210', v.phoneNormalized);
    check('normalize: domain', v.domain === 'acme.com', v.domain);
    check('normalize: name', v.normalizedName === 'acme', v.normalizedName);
    check('normalize: email', v.emailNormalized === 'foo@acme.com', v.emailNormalized);
  }
}

const mk = (o: Partial<{ claimedBy: string | null; claimExpiresAt: Date | null; promotedDealId: string | null; deletedAt: Date | null; stage: 'dump' | 'researching' | 'qualified' | 'ready' | 'parked' }> = {}) => ({
  claimedBy: null, claimExpiresAt: null, promotedDealId: null, deletedAt: null, stage: 'dump' as const, ...o,
});
const me = { userId: 'u1', role: 'member' as const };
{
  const day = 86_400_000;
  check("move: member moves other's EXPIRED claim -> null", stageMoveBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() - day) }), 'qualified', me) === null);
  check("move: member moves other's active claim -> 'claimed_by_other'", stageMoveBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() + day) }), 'qualified', me) === 'claimed_by_other');
}
check('move: member moves own claimed card', stageMoveBlock(mk({ claimedBy: 'u1' }), 'qualified', me) === null);
check("move: member moves other's claimed", stageMoveBlock(mk({ claimedBy: 'u2' }), 'qualified', me) === 'claimed_by_other');
check("move: manager moves other's claimed", stageMoveBlock(mk({ claimedBy: 'u2' }), 'qualified', { userId: 'm', role: 'manager' }) === null);
check('move: promoted', stageMoveBlock(mk({ promotedDealId: 'd' }), 'qualified', me) === 'promoted');
check('move: deleted', stageMoveBlock(mk({ deletedAt: new Date() }), 'qualified', me) === 'deleted');
check('move: viewer', stageMoveBlock(mk(), 'qualified', { userId: 'v', role: 'viewer' }) === 'no_permission');
check('move: same stage', stageMoveBlock(mk(), 'dump', me) === 'same_stage');
check("edit: member edits other's claimed card", editBlock(mk({ claimedBy: 'u2' }), me) === null);
check('edit: promoted blocked', editBlock(mk({ promotedDealId: 'd' }), me) === 'promoted');
check('edit: viewer blocked', editBlock(mk(), { userId: 'v', role: 'viewer' }) === 'no_permission');

const f = parseProspectFilters({ stage: 'won', groupBy: 'x', mine: '1' });
check('filters: junk ignored', JSON.stringify(f) === JSON.stringify({ mine: true }), f);

const card = (o: Partial<ProspectCard>): ProspectCard => ({
  id: 'p', companyName: 'A', contactName: null, contactEmail: null, sourceTag: 's', clusterTags: [],
  industry: null, city: null, state: null, sizeBand: null, productFitOfferingId: null, productFitName: null,
  icpScore: null, stage: 'dump', claimedBy: null, claimExpiresAt: null, votesKnowSomeone: 0, votesPriority: 0,
  promotedDealId: null, lastActivityAt: new Date(), ...o,
});
check('group: null industry -> None lane', groupKeyOf(card({}), 'industry').key === '__none' && groupKeyOf(card({}), 'industry').label === 'None');
check('group: industry case-insensitive', groupKeyOf(card({ industry: 'Textiles' }), 'industry').key === groupKeyOf(card({ industry: 'textiles ' }), 'industry').key && groupKeyOf(card({ industry: ' Textiles ' }), 'industry').label === 'Textiles');
check('group: source_tag case-insensitive', groupKeyOf(card({ sourceTag: 'Expo' }), 'source_tag').key === groupKeyOf(card({ sourceTag: 'expo' }), 'source_tag').key);
check('group: territory', groupKeyOf(card({ state: 'MH', city: 'Pune' }), 'territory').label === 'MH · Pune', groupKeyOf(card({ state: 'MH', city: 'Pune' }), 'territory'));
check('group: product_fit', groupKeyOf(card({ productFitOfferingId: 'o1', productFitName: 'CRM' }), 'product_fit').label === 'CRM');

const dayMs = 86_400_000;
check('claim: member on unclaimed', claimBlock(mk(), me) === null);
check("claim: member on other's active", claimBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() + dayMs) }), me) === 'claimed_by_other');
check("claim: member on other's expired", claimBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() - dayMs) }), me) === null);
check('claim: viewer', claimBlock(mk(), { userId: 'v', role: 'viewer' }) === 'no_permission');
check('claim: own active claim extends', claimBlock(mk({ claimedBy: 'u1', claimExpiresAt: new Date(Date.now() + dayMs) }), me) === null);
check('claim: promoted/deleted', claimBlock(mk({ promotedDealId: 'd' }), me) === 'promoted' && claimBlock(mk({ deletedAt: new Date() }), me) === 'deleted');
check("release: manager on other's claim", releaseBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() + dayMs) }), { userId: 'm', role: 'manager' }) === null);
check("release: member on other's claim", releaseBlock(mk({ claimedBy: 'u2', claimExpiresAt: new Date(Date.now() + dayMs) }), me) === 'claimed_by_other');
check('release: unclaimed', releaseBlock(mk(), me) === 'not_claimed');
check('release: own claim', releaseBlock(mk({ claimedBy: 'u1' }), me) === null);

check('rbac: viewer manageProspects', can('viewer', 'manageProspects') === false);
check('rbac: member manageProspectClaims', can('member', 'manageProspectClaims') === false);
check('rbac: manager bulkParkProspects', can('manager', 'bulkParkProspects') === true);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\nprospects selftest: ${passed} passed, ${results.length - passed} failed`);
process.exit(exitCode);
