import { withTenantSession } from '@/lib/auth-guard';
import { suggestionsClaudeConfigured } from '@/lib/ai/suggestions/extract';
import { suggestionMetrics, type SuggestionMetricRow } from '@/lib/ai/suggestions/service';
import { FIELD_LABELS } from '@/lib/ai/suggestions/view';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';

import { SuggestionsToggle } from './_components/suggestions-toggle';

export const metadata = { title: 'AI suggestions · Settings' };

function MetricTable({ title, keyLabel, rows, label }: { title: string; keyLabel: string; rows: SuggestionMetricRow[]; label: (k: string) => string }) {
  return (
    <section className="rounded-lg border border-slate-200 dark:border-[#1F1F1F]">
      <h2 className="border-b border-slate-200 px-4 py-2 text-[13px] font-semibold text-slate-900 dark:border-[#1F1F1F] dark:text-[#FAFAFA]">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-slate-500">No suggestions in the last 90 days.</p>
      ) : (
        <table className="w-full text-left text-[12px]">
          <thead className="text-slate-500">
            <tr>
              <th className="px-4 py-1.5 font-medium">{keyLabel}</th>
              <th className="px-2 py-1.5 text-right font-medium">Acceptance</th>
              <th className="px-2 py-1.5 text-right font-medium">Accepted</th>
              <th className="px-2 py-1.5 text-right font-medium">Rejected</th>
              <th className="px-2 py-1.5 text-right font-medium">Stale</th>
              <th className="px-2 py-1.5 text-right font-medium">Superseded</th>
              <th className="px-4 py-1.5 text-right font-medium">Pending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-slate-100 dark:border-[#181818]">
                <td className="px-4 py-1.5 text-slate-800 dark:text-[#E4E4E7]">{label(r.key)}</td>
                <td className="px-2 py-1.5 text-right font-medium tabular-nums">{r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.accepted}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.rejected}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.stale}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.superseded}</td>
                <td className="px-4 py-1.5 text-right tabular-nums">{r.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Admin: the on/off switch and acceptance rates by field and by model (last 90 days). */
export default async function AiSuggestionsSettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [settings, metrics] = await Promise.all([getOrgSettings(tenant.id), suggestionMetrics(tenant.id)]);
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">AI suggestions</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Acceptance = accepted ÷ (accepted + rejected). Stale means the field had changed before anyone decided; superseded
            means a newer suggestion replaced it.
          </p>
        </header>
        <SuggestionsToggle initial={settings.aiSuggestionsEnabled} claudeConfigured={suggestionsClaudeConfigured()} />
        <MetricTable title="By field" keyLabel="Field" rows={metrics.byField} label={(k) => FIELD_LABELS[k as keyof typeof FIELD_LABELS] ?? k} />
        <MetricTable title="By model" keyLabel="Model" rows={metrics.byModel} label={(k) => (k === 'call-summary' ? 'Call summary (follow-ups)' : k)} />
      </div>
    );
  });
}
