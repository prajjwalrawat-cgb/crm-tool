'use client';

import { GitBranch, Percent } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';
import {
  CONFIGURABLE_PROBABILITY_STAGES,
  type StageProbabilities,
} from '@/lib/deals/stage-probability';

import { updatePipelineSettingsAction } from '../../actions';
import {
  InputRow,
  SelectRow,
  SettingsForm,
  SettingsSection,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  defaultDealStage: (typeof DEAL_STAGES)[number];
  defaultReportRange: string;
  dashboardMetrics: string;
  fiscalYearStartMonth: number;
  dealUnitPricingEnabled: boolean;
  stageProbabilities: StageProbabilities;
};

const REPORT_RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_30d', label: 'Last 30 days' },
  { value: 'last_90d', label: 'Last 90 days' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'all_time', label: 'All time' },
];

const MONTH_OPTIONS = [
  { value: '1', label: 'January' },
  { value: '2', label: 'February' },
  { value: '3', label: 'March' },
  { value: '4', label: 'April (Indian FY)' },
  { value: '5', label: 'May' },
  { value: '6', label: 'June' },
  { value: '7', label: 'July (US Federal FY)' },
  { value: '8', label: 'August' },
  { value: '9', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

export function PipelineForm({ initial }: { initial: Values }) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const read = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)
        ?.value ?? '';
    const readBool = (name: string) =>
      (root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)
        ?.checked ?? false;
    const stageProbabilities = { ...initial.stageProbabilities };
    for (const stage of CONFIGURABLE_PROBABILITY_STAGES) {
      const raw = read(`prob_${stage}`);
      const n = Number(raw);
      if (Number.isFinite(n)) {
        stageProbabilities[stage] = Math.min(100, Math.max(0, Math.round(n)));
      }
    }
    return {
      defaultDealStage: read('defaultDealStage') as Values['defaultDealStage'],
      defaultReportRange: read('defaultReportRange'),
      dashboardMetrics: read('dashboardMetrics'),
      fiscalYearStartMonth: Number(read('fiscalYearStartMonth')) || 1,
      dealUnitPricingEnabled: readBool('dealUnitPricingEnabled'),
      stageProbabilities,
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm
        initial={initial}
        action={updatePipelineSettingsAction}
        collectChanges={collect}
      >
        <SettingsSection
          title="Pipeline"
          description="Defaults for newly-created deals and reports."
          icon={GitBranch}
        >
          <SelectRow
            name="defaultDealStage"
            label="Default deal stage"
            description="Stage newly-created deals land in when none is selected."
            defaultValue={initial.defaultDealStage}
            options={DEAL_STAGES.map((s) => ({
              value: s,
              label: DEAL_STAGE_LABELS[s] ?? s,
            }))}
          />
          <SelectRow
            name="defaultReportRange"
            label="Default report range"
            description="Time window applied to reports and dashboards on first load."
            defaultValue={initial.defaultReportRange}
            options={REPORT_RANGE_OPTIONS}
          />
          <SelectRow
            name="fiscalYearStartMonth"
            label="Fiscal year start"
            description="Drives forecast bucketing and 'this year' report windows."
            defaultValue={String(initial.fiscalYearStartMonth)}
            options={MONTH_OPTIONS}
          />
          <InputRow
            name="dashboardMetrics"
            label="Dashboard metrics"
            description="Comma-separated metric ids shown on the main dashboard. Order matters."
            defaultValue={initial.dashboardMetrics}
            placeholder="pipeline,won,wonRecent,activity"
          />
          <ToggleRow
            name="dealUnitPricingEnabled"
            label="Per-unit deal pricing"
            description="Show Per Unit Price and Quantity on the deal form; Amount is calculated automatically (unit price x quantity)."
            defaultChecked={initial.dealUnitPricingEnabled}
          />
        </SettingsSection>

        <SettingsSection
          title="Stage win probabilities"
          description="Weights the pipeline value shown beneath each board column (weighted = amount × probability). Won is fixed at 100%, Lost at 0%."
          icon={Percent}
        >
          {CONFIGURABLE_PROBABILITY_STAGES.map((stage) => (
            <label
              key={stage}
              className="flex items-center justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0 dark:border-[#1F1F1F]"
            >
              <span className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
                {DEAL_STAGE_LABELS[stage]}
              </span>
              <span className="relative inline-flex items-center">
                <input
                  type="number"
                  name={`prob_${stage}`}
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={initial.stageProbabilities[stage]}
                  className="w-20 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 pr-6 text-right text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
                />
                <span className="pointer-events-none absolute right-2 text-[12px] text-slate-400">
                  %
                </span>
              </span>
            </label>
          ))}
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
