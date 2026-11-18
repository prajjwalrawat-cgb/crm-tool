import { withTenantSession } from '@/lib/auth-guard';
import { listDistributionRules, listLeadSources, listRoutingProfiles } from '@/lib/lead-capture/admin';
import { requirePersonas } from '@/lib/personas/guards';
import { listTeammates } from '@/lib/teammates/queries';

import { DistributionManager } from './_components/distribution-manager';

export const metadata = { title: 'Distribution · Settings' };

export default async function DistributionSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [rules, sources, profiles, teammates] = await Promise.all([
      listDistributionRules(tenant.id),
      listLeadSources(tenant.id),
      listRoutingProfiles(tenant.id),
      listTeammates(tenant.id, tenant.name),
    ]);
    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Lead distribution</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Rules are checked top to bottom; the first one whose conditions all match a lead decides who gets it.
            If none match, the source&apos;s fallback rule and then the workspace default apply. Only people who are
            available, on shift and under the rule&apos;s capacity can receive a lead. An untouched lead is reassigned
            when its first-response SLA runs out.
          </p>
        </header>
        <DistributionManager
          rules={rules.map((r) => ({
            id: r.id,
            name: r.name,
            priority: r.priority,
            conditions: r.conditions ?? [],
            strategy: r.strategy,
            pool: r.pool ?? { user_ids: [] },
            capacityCap: r.capacityCap,
            respectAvailability: r.respectAvailability,
            slaMinutes: r.slaMinutes,
            maxReassignments: r.maxReassignments,
            isDefault: r.isDefault,
            isActive: r.isActive,
          }))}
          sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          people={teammates
            .filter((t) => t.role && t.role !== 'viewer')
            .map((t) => ({ id: t.id, name: t.displayName, role: t.role }))}
          profiles={profiles.map((p) => ({
            userId: p.userId,
            isAvailable: p.isAvailable,
            workingHours: p.workingHours ?? null,
            skills: p.skills ?? [],
            regions: p.regions ?? [],
          }))}
        />
      </main>
    );
  });
}
