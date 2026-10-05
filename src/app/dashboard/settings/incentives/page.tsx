import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { fmtL } from '@/lib/incentives/format';
import { getTemplate, listPlans } from '@/lib/incentives/queries';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { requirePersonas } from '@/lib/personas/guards';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { Panel } from '../../incentives/_components/incentive-calculator';
import { RecomputeButton } from '../../incentives/_components/recompute-button';
import { FiscalYearSelect } from '../../targets/_components/fy-select';
import { TemplateEditor } from './_components/template-editor';

export const metadata = { title: 'Incentives · Settings' };

export default async function IncentiveSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    const choices = fiscalYearChoices(startMonth, now);
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy) ? parsedFy : currentFiscalYear(startMonth, now);
    const label = fiscalYearLabel(startMonth, fiscalYear);

    const [teammates, plans, template] = await Promise.all([
      listTeammates(tenant.id, tenant.name),
      listPlans(tenant.id, fiscalYear),
      getTemplate(tenant.id),
    ]);
    const planByUser = new Map(plans.map((p) => [p.userId, p]));
    // Resources = anyone who carries a target (managers + reps), plus anyone
    // who already has a plan whatever their role.
    const resources = teammates
      .filter((t) => personaOf(t.role) !== 'admin' || planByUser.has(t.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const computedActive = plans.filter((p) => p.status === 'active' && p.actualsSource === 'computed').length;

    return (
      <main className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Incentive plans</h1>
            <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Each resource gets their own plan per fiscal year, starting from the workspace template. Compensation in ₹ Lakh,
              revenue in ₹ Crore. Every change is versioned and attributed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/incentives?fy=${fiscalYear}`} className="text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300">
              Roll-up →
            </Link>
            <FiscalYearSelect value={fiscalYear} choices={choices.map((y) => ({ value: y, label: fiscalYearLabel(startMonth, y) }))} />
          </div>
        </header>

        <Panel
          title={`Plans · ${label}`}
          aside={
            <div className="flex items-center gap-2">
              {computedActive > 0 ? <RecomputeButton label={`Recompute ${computedActive} computed`} /> : null}
              <Link
                href={`/dashboard/settings/incentives/bulk?fy=${fiscalYear}`}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#D4D4D8] dark:hover:bg-[#181818]"
              >
                Bulk rate change
              </Link>
            </div>
          }
        >
          <table className="w-full text-[13px]">
            <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              <tr>
                <th className="py-1.5 font-medium">Resource</th>
                <th className="py-1.5 font-medium">Status</th>
                <th className="py-1.5 text-right font-medium">Fixed CTC</th>
                <th className="py-1.5 text-right font-medium">Target variable</th>
                <th className="py-1.5 font-medium">Actuals</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {resources.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">No team members yet.</td>
                </tr>
              ) : (
                resources.map((t) => {
                  const p = planByUser.get(t.id);
                  return (
                    <tr key={t.id} className="border-t border-slate-100 dark:border-[#1F1F1F]">
                      <td className="py-2">
                        <div className="font-medium text-slate-800 dark:text-[#FAFAFA]">{t.displayName}</div>
                        {t.role ? <div className="text-[11px] capitalize text-slate-400">{t.role}</div> : null}
                      </td>
                      <td className="py-2">
                        {p ? (
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[11px] font-medium uppercase',
                              p.status === 'active' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                              p.status === 'draft' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
                              p.status === 'closed' && 'bg-slate-100 text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]',
                            )}
                          >
                            {p.status} · v{p.version}
                          </span>
                        ) : (
                          <span className="text-[12px] text-slate-400">No plan</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">{p ? fmtL(Number(p.fixedCtc)) : '—'}</td>
                      <td className="py-2 text-right tabular-nums">{p ? fmtL(Number(p.targetVariable)) : '—'}</td>
                      <td className="py-2 text-[12px] text-slate-500">{p ? p.actualsSource : '—'}</td>
                      <td className="py-2 text-right">
                        <Link
                          href={
                            p
                              ? `/dashboard/settings/incentives/plan?planId=${p.id}`
                              : `/dashboard/settings/incentives/plan?userId=${encodeURIComponent(t.id)}&fy=${fiscalYear}`
                          }
                          className="text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
                        >
                          {p ? 'Edit' : 'Create from template'}
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Workspace template"
          aside={<span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">{template.updatedAt ? 'saved' : 'workbook defaults — not saved yet'}</span>}
        >
          <TemplateEditor initialTerms={template.terms} initialBudget={template.budgetL} />
        </Panel>
      </main>
    );
  });
}
