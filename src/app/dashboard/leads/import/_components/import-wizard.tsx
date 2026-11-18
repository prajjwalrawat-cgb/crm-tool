'use client';

import { Sparkles, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { LEAD_FIELD_KEYS, type LeadFieldKey } from '@/lib/lead-capture/constants';
import { cn } from '@/lib/utils';

import { commitImportAction, getImportJobAction, previewImportAction, revalidateImportPreviewAction } from '../../actions';
import { Badge, Button, Card, Field, selectCls } from '../../../settings/lead-capture/_components/ui';

type PreviewRow = { index: number; values: Record<string, string>; error: string | null };
type Preview = {
  headers: string[];
  totalRows: number;
  suggestion: { mapping: Record<string, LeadFieldKey | null>; confidence: number; method: 'ai' | 'heuristic' };
  rows: PreviewRow[];
  truncated: boolean;
};
type Job = {
  status: string;
  total: number;
  processed: number;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  errors: Array<{ row: number; error: string }>;
};

const LABEL: Record<LeadFieldKey, string> = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  title: 'Job title',
  city: 'City',
  state: 'State',
  product_interest: 'Product interest',
  message: 'Message / notes',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  utm_term: 'UTM term',
  utm_content: 'UTM content',
  landing_url: 'Landing URL',
  referrer_url: 'Referrer URL',
  consent: 'Consent',
};

const STEPS = ['Upload', 'Map columns', 'Review', 'Import'] as const;

export function ImportWizard({ sources }: { sources: Array<{ id: string; name: string; type: string }> }) {
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, LeadFieldKey | null>>({});
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [sourceId, setSourceId] = useState(sources.find((s) => s.type === 'csv_import')?.id ?? '');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    if (file.size > 4 * 1024 * 1024) return void toast.error('The file is larger than 4 MB. Split it and import in parts.');
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    startTransition(async () => {
      const r = await previewImportAction(text);
      if (!r.ok) return void toast.error(r.message);
      setPreview(r.data!);
      setMapping(r.data!.suggestion.mapping);
      setRows(r.data!.rows);
      setStep(1);
    });
  }

  function setColumn(header: string, key: LeadFieldKey | null) {
    // One column per field: picking a field another column holds clears that one.
    const next = Object.fromEntries(Object.entries(mapping).map(([h, v]) => [h, key && v === key && h !== header ? null : v])) as Record<string, LeadFieldKey | null>;
    next[header] = key;
    setMapping(next);
    startTransition(async () => {
      // Only the header + first rows are needed to re-check the preview.
      const head = csv.split(/\r?\n/).slice(0, 60).join('\n');
      const r = await revalidateImportPreviewAction(head, next);
      if (r.ok) setRows(r.data!);
    });
  }

  function commit() {
    startTransition(async () => {
      const r = await commitImportAction({ csvText: csv, fileName, mapping, sourceId: sourceId || null });
      if (!r.ok) return void toast.error(r.message);
      setJobId(r.data!.jobId);
      setJob({ status: 'queued', total: r.data!.total, processed: 0, createdCount: 0, duplicateCount: 0, failedCount: 0, errors: [] });
      setStep(3);
    });
  }

  useEffect(() => {
    if (!jobId || job?.status === 'done' || job?.status === 'failed') return;
    const t = setInterval(async () => {
      const r = await getImportJobAction(jobId);
      if (r.ok) setJob(r.data);
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, job?.status]);

  const mappedContact = Object.values(mapping).some((v) => v === 'phone' || v === 'email');
  const errorCount = rows.filter((r) => r.error).length;
  const pct = job && job.total ? Math.round((job.processed / job.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2" aria-label="Import steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'rounded-full px-3 py-1 text-[12px] font-medium',
              i === step ? 'bg-indigo-600 text-white' : i < step ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300' : 'bg-slate-100 text-slate-500 dark:bg-[#1A1A1A]',
            )}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Card title="Upload a CSV">
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-10 text-center dark:border-[#333]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void onFile(f);
            }}
          >
            <Upload className="h-6 w-6 text-slate-400" aria-hidden />
            <p className="text-[13px] text-slate-600 dark:text-[#A1A1AA]">Drop a .csv file here, or</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
            <Button variant="primary" disabled={pending} onClick={() => fileRef.current?.click()}>
              {pending ? 'Reading…' : 'Choose file'}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 1 && preview ? (
        <Card
          title={`Map columns · ${fileName}`}
          description={`${preview.totalRows} rows${preview.truncated ? ' (only the first 10,000 will be imported)' : ''}.`}
          actions={
            <>
              <Badge tone={preview.suggestion.method === 'ai' ? 'duplicate' : 'inactive'}>
                {preview.suggestion.method === 'ai' ? (
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3" aria-hidden /> Suggested by AI from column names
                  </span>
                ) : (
                  'Matched by column names'
                )}
              </Badge>
              <Button onClick={() => setStep(0)}>Back</Button>
              <Button variant="primary" disabled={!mappedContact || pending} onClick={() => setStep(2)}>
                Next
              </Button>
            </>
          }
        >
          {!mappedContact ? <p className="mb-2 text-[12px] text-rose-700 dark:text-rose-300">Map at least one column to Phone or Email.</p> : null}
          <div className="grid gap-2 md:grid-cols-2">
            {preview.headers.map((h) => (
              <div key={h} className="flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-[#262626]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-slate-900 dark:text-[#FAFAFA]">{h}</div>
                  <div className="truncate text-[11px] text-slate-500">{preview.rows[0]?.values[h] || '—'}</div>
                </div>
                <select
                  className={cn(selectCls, 'w-48')}
                  aria-label={`Field for column ${h}`}
                  value={mapping[h] ?? ''}
                  onChange={(e) => setColumn(h, (e.target.value || null) as LeadFieldKey | null)}
                >
                  <option value="">Don&apos;t import</option>
                  {LEAD_FIELD_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {step === 2 && preview ? (
        <Card
          title="Review"
          description={errorCount ? `${errorCount} of the first ${rows.length} rows can't become a lead and will be recorded as failed.` : `The first ${rows.length} rows look good.`}
          actions={
            <>
              <Button onClick={() => setStep(1)}>Back</Button>
              <Button variant="primary" disabled={pending} onClick={commit}>
                Import {preview.totalRows} rows
              </Button>
            </>
          }
        >
          <Field label="Lead source" hint="Imported leads are tagged with this source and follow its distribution fallback.">
            <select className={cn(selectCls, 'max-w-sm')} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">CSV import (created automatically)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">#</th>
                  {preview.headers.filter((h) => mapping[h]).map((h) => (
                    <th key={h} className="py-1 pr-2 font-medium">
                      {LABEL[mapping[h]!]}
                    </th>
                  ))}
                  <th className="py-1 pr-2 font-medium">Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
                {rows.map((r) => (
                  <tr key={r.index} className={r.error ? 'bg-rose-50/60 dark:bg-rose-500/5' : undefined}>
                    <td className="py-1 pr-2 text-slate-400">{r.index}</td>
                    {preview.headers.filter((h) => mapping[h]).map((h) => (
                      <td key={h} className="max-w-[12rem] truncate py-1 pr-2">
                        {r.values[h] || '—'}
                      </td>
                    ))}
                    <td className="py-1 pr-2">{r.error ? <span className="text-rose-700 dark:text-rose-300">✕ {r.error}</span> : <span className="text-emerald-700 dark:text-emerald-300">✓ ok</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {step === 3 && job ? (
        <Card title={job.status === 'done' ? 'Import finished' : 'Importing…'}>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-[#1A1A1A]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
            <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 text-[12.5px] text-slate-600 dark:text-[#A1A1AA]">
            {job.processed} / {job.total} rows · {job.createdCount} new leads · {job.duplicateCount} matched existing leads · {job.failedCount} failed
          </div>
          {job.errors.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12.5px] text-rose-700 dark:text-rose-300">Row errors ({job.errors.length})</summary>
              <ul className="mt-1 max-h-48 overflow-y-auto text-[12px]">
                {job.errors.map((e, i) => (
                  <li key={i}>
                    Row {e.row}: {e.error}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {job.status === 'done' ? (
            <div className="mt-3 flex gap-2">
              <Link href="/dashboard/deals?stage=lead" className="text-[12.5px] font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                View leads
              </Link>
              <Button
                onClick={() => {
                  setStep(0);
                  setPreview(null);
                  setJob(null);
                  setJobId(null);
                }}
              >
                Import another file
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-slate-500">You can leave this page; the import keeps running.</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}
