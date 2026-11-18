'use client';

import { Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { SavedReport } from '@/db/schema';
import { METRICS, type MetricKey } from '@/lib/reports/metrics';

import { deleteSavedReportAction, saveReportAction } from '../actions';
import { Card, EmptyState } from './ui';

const ROLLUP_KEYS = (Object.keys(METRICS) as MetricKey[]).filter((k) => METRICS[k].source === 'rollup');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function SavedReports({
  reports,
  people,
  me,
  canScheduleForOthers,
}: {
  reports: SavedReport[];
  people: Array<{ id: string; name: string }>;
  me: string;
  canScheduleForOthers: boolean;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState('');
  const [metrics, setMetrics] = useState<MetricKey[]>(['lead_volume', 'won_value', 'contact_rate']);
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'mtd'>('7d');
  const [scheduled, setScheduled] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
  const [hour, setHour] = useState(9);
  const [weekday, setWeekday] = useState(1);
  const [recipients, setRecipients] = useState<string[]>([me]);

  const submit = () =>
    start(async () => {
      const r = await saveReportAction({
        name,
        definition: { metrics, range, compare: 'previous', groupBy: null },
        schedule: scheduled ? { frequency, hour, weekday: frequency === 'weekly' ? weekday : undefined, recipients, format: 'email' } : null,
      });
      if (r.ok) {
        toast.success('Report saved');
        setName('');
      } else toast.error(r.error);
    });

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card title="Saved reports" className="lg:col-span-3">
        {reports.length === 0 ? (
          <EmptyState title="No saved reports yet" body="Pick metrics and a period on the right, then save. Add a schedule to get it by email." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {reports.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900">{r.name}</div>
                  <div className="text-[12px] text-slate-500">
                    {r.definition.metrics.map((m) => METRICS[m as MetricKey]?.label ?? m).join(', ')} · {r.definition.range}
                    {r.schedule && ` · emailed ${r.schedule.frequency === 'weekly' ? `${DAYS[r.schedule.weekday ?? 1]}s` : 'daily'} at ${String(r.schedule.hour).padStart(2, '0')}:00 to ${r.schedule.recipients.length}`}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Delete ${r.name}`}
                  disabled={pending || r.ownerId !== me}
                  onClick={() => start(async () => void (await deleteSavedReportAction(r.id)))}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-700 disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="New report" className="lg:col-span-2">
        <div className="space-y-3 text-[12.5px]">
          <label className="block">
            <span className="text-slate-600">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" placeholder="Weekly team numbers" />
          </label>
          <fieldset>
            <legend className="text-slate-600">Metrics</legend>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {ROLLUP_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={metrics.includes(k)} onChange={(e) => setMetrics((m) => (e.target.checked ? [...m, k] : m.filter((x) => x !== k)))} />
                  {METRICS[k].label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-slate-600">Period</span>
            <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5">
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="mtd">Month to date</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
            Email it on a schedule
          </label>
          {scheduled && (
            <div className="space-y-2 rounded-md bg-slate-50 p-2">
              <div className="flex flex-wrap gap-2">
                <select aria-label="Frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly')} className="rounded border border-slate-300 bg-white px-1.5 py-1">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                {frequency === 'weekly' && (
                  <select aria-label="Day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="rounded border border-slate-300 bg-white px-1.5 py-1">
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
                <select aria-label="Hour" value={hour} onChange={(e) => setHour(Number(e.target.value))} className="rounded border border-slate-300 bg-white px-1.5 py-1">
                  {Array.from({ length: 24 }).map((_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </div>
              <fieldset>
                <legend className="text-slate-600">Send to</legend>
                <div className="mt-1 max-h-32 space-y-0.5 overflow-auto">
                  {people
                    .filter((p) => canScheduleForOthers || p.id === me)
                    .map((p) => (
                      <label key={p.id} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={recipients.includes(p.id)} onChange={(e) => setRecipients((r) => (e.target.checked ? [...r, p.id] : r.filter((x) => x !== p.id)))} />
                        {p.name}
                      </label>
                    ))}
                </div>
              </fieldset>
              <p className="text-[11px] text-slate-500">Each person sees the numbers for their own team, in the workspace timezone.</p>
            </div>
          )}
          <button type="button" disabled={pending || !name.trim() || metrics.length === 0} onClick={submit} className="w-full rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50">
            Save report
          </button>
        </div>
      </Card>
    </div>
  );
}
