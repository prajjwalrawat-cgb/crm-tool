'use client';

import { Brain } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { updateAiSettingsAction } from '../../actions';
import {
  SelectRow,
  SettingsForm,
  SettingsSection,
  ToggleRow,
} from '../../_components/settings-form';

type Values = {
  aiEnabled: boolean;
  aiAggressiveness: 'conservative' | 'balanced' | 'aggressive';
  insightRefresh: 'on_change' | 'hourly' | 'daily' | 'manual';
};

const AGGRESSIVENESS_OPTIONS = [
  { value: 'conservative', label: 'Conservative — only high-confidence insights' },
  { value: 'balanced', label: 'Balanced — default mix of signal and noise control' },
  { value: 'aggressive', label: 'Aggressive — surface more, even with lower confidence' },
];

const REFRESH_OPTIONS = [
  { value: 'on_change', label: 'On change — refresh when underlying data shifts' },
  { value: 'hourly', label: 'Hourly background refresh' },
  { value: 'daily', label: 'Daily background refresh' },
  { value: 'manual', label: 'Manual — refresh only when I click reload' },
];

export function AiForm({
  initial,
  aiMode,
}: {
  initial: Values;
  aiMode: 'live' | 'mock' | 'disabled';
}) {
  const formRef = useRef<HTMLDivElement>(null);

  const collect = useCallback((): Values => {
    const root = formRef.current;
    if (!root) return initial;
    const readSel = (name: string) =>
      (root.querySelector(`select[name="${name}"]`) as HTMLSelectElement | null)?.value ?? '';
    const readCheck = (name: string) =>
      (root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.checked ?? false;
    return {
      aiEnabled: readCheck('aiEnabled'),
      aiAggressiveness: readSel('aiAggressiveness') as Values['aiAggressiveness'],
      insightRefresh: readSel('insightRefresh') as Values['insightRefresh'],
    };
  }, [initial]);

  return (
    <div ref={formRef}>
      <SettingsForm
        initial={initial}
        action={updateAiSettingsAction}
        collectChanges={collect}
      >
        <SettingsSection
          title="AI"
          description="Generation behavior for intelligence, recommendations, and deal summaries."
          icon={Brain}
        >
          <ToggleRow
            name="aiEnabled"
            label="Enable AI features"
            description="Turning off pauses generation across intelligence and deal pages. Existing summaries remain visible until they age out."
            defaultChecked={initial.aiEnabled}
          />
          <SelectRow
            name="aiAggressiveness"
            label="Recommendation aggressiveness"
            description="Controls confidence floor for surfaced recommendations and risk flags."
            defaultValue={initial.aiAggressiveness}
            options={AGGRESSIVENESS_OPTIONS}
          />
          <SelectRow
            name="insightRefresh"
            label="Insight refresh policy"
            description="When the read-through cache should regenerate. on_change is the default and works for most workspaces."
            defaultValue={initial.insightRefresh}
            options={REFRESH_OPTIONS}
          />
        </SettingsSection>

        <div className="mt-3 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-[#1F1F1F] dark:bg-[#111111]">
          <div>
            <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              Runtime AI mode
            </div>
            <div className="mt-0.5 text-[11.5px] text-slate-600 dark:text-[#A1A1AA]">
              {aiMode === 'live'
                ? 'OpenAI API key configured — real generations are running.'
                : aiMode === 'mock'
                  ? 'AI_ENABLED is off — deterministic mock outputs are served.'
                  : 'AI_ENABLED is on but OPENAI_API_KEY is missing — falling back to mock.'}
            </div>
          </div>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-700 dark:bg-[#181818] dark:text-[#FAFAFA]">
            {aiMode}
          </span>
        </div>
      </SettingsForm>
    </div>
  );
}
