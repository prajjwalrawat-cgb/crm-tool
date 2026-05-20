'use client';

import { GitBranch } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';

import { updatePipelineSettingsAction } from '../../actions';
import {
  InputRow,
  SelectRow,
  SettingsForm,
  SettingsSection,
} from '../../_components/settings-form';

type Values = {
  defaultDealStage: (typeof DEAL_STAGES)[number];
  defaultReportRange: string;
  dashboardMetrics: string;
  fiscalYearStartMonth: number;
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
    return {
      defaultDealStage: read('defaultDealStage') as Values['defaultDealStage'],
      defaultReportRange: read('defaultReportRange'),
      dashboardMetrics: read('dashboardMetrics'),
      fiscalYearStartMonth: Number(read('fiscalYearStartMonth')) || 1,
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
        </SettingsSection>
      </SettingsForm>
    </div>
  );
}
