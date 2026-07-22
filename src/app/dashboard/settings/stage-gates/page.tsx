import { withTenantSession } from '@/lib/auth-guard';
import { requirePersonas } from '@/lib/personas/guards';
import { listStageGates } from '@/lib/stage-gates/queries';
import { getWorkspaceSettings } from '@/lib/workspace-settings/queries';

import { StageGatesManager } from './_components/stage-gates-manager';

export const metadata = { title: 'Stage Gates · Settings' };

export default async function StageGatesSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [settings, gates] = await Promise.all([
      getWorkspaceSettings(tenant.id),
      listStageGates(tenant.id),
    ]);

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Stage gates
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Define what a deal must satisfy before it can advance into a stage —
            the saleinx equivalent of Salesforce Path + validation rules.
            <span className="font-medium">&nbsp;Block</span> rules reject the
            move; <span className="font-medium">Warn</span> rules allow it but
            record a note on the deal timeline.
          </p>
        </header>
        <StageGatesManager
          enabled={settings.stageGatesEnabled}
          gates={gates.map((g) => ({
            id: g.id,
            stage: g.stage,
            ruleType: g.ruleType,
            ruleConfig: g.ruleConfig,
            severity: g.severity,
            isActive: g.isActive,
          }))}
        />
      </main>
    );
  });
}
