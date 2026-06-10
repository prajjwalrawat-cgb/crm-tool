'use client';

import { CheckCircle2, Loader2, Upload, X } from 'lucide-react';
import { useId, useRef, useState, useTransition } from 'react';

import { Drawer } from '../../_components/drawer';
import { bulkUploadDealsAction, type BulkUploadResult } from '../actions';

/**
 * "Bulk upload" entry point in the deals page header. Opens a
 * drawer with a file input and shows a per-row results panel.
 *
 * Format: CSV (Excel users save-as `.csv (Comma delimited)`).
 * We deliberately do NOT support `.xlsx` in v1 to keep the bundle
 * small — adding SheetJS is ~500KB. If users actually need native
 * Excel upload we'll add it as a follow-up.
 */
export function BulkUploadButton() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BulkUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputId = useId();

  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
    setFileName(null);
    formRef.current?.reset();
  };

  const handleSubmit = (formData: FormData) => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await bulkUploadDealsAction(formData);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setResult(res);
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      >
        <Upload className="h-4 w-4" aria-hidden />
        Bulk upload
      </button>

      <Drawer
        open={open}
        onClose={close}
        title="Bulk upload deals"
        description="Import deals from a CSV file (Excel → Save As → CSV)."
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              {result ? 'Done' : 'Cancel'}
            </button>
            {!result ? (
              <button
                type="submit"
                form="bulk-upload-form"
                disabled={pending || !fileName}
                className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" aria-hidden />
                    Upload
                  </>
                )}
              </button>
            ) : null}
          </div>
        }
      >
        {result ? (
          <ResultPanel result={result} onReset={() => {
            setResult(null);
            setFileName(null);
            formRef.current?.reset();
          }} />
        ) : (
          <form
            id="bulk-upload-form"
            ref={formRef}
            action={handleSubmit}
            className="flex flex-col gap-4"
          >
            <FormatHelp />

            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-xs font-medium text-slate-700">
                CSV file
              </label>
              <input
                id={inputId}
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
              {fileName ? (
                <p className="text-xs text-slate-500">Selected: {fileName}</p>
              ) : null}
            </div>

            <a
              href={TEMPLATE_DATA_URL}
              download="deals-template.csv"
              className="self-start text-xs text-indigo-600 underline-offset-2 hover:underline"
            >
              Download template CSV
            </a>

            {error ? (
              <p
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                {error}
              </p>
            ) : null}
          </form>
        )}
      </Drawer>
    </>
  );
}

function FormatHelp() {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
      <p className="font-medium text-slate-700">Expected columns</p>
      <p className="mt-1">
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">name</code>{' '}
        (required),{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">description</code>,{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">stage</code>{' '}
        (lead, qualified, proposal, negotiation, won, lost),{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">amount</code>,{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">currency</code>,{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">expectedCloseDate</code>{' '}
        (YYYY-MM-DD),{' '}
        <code className="rounded bg-white px-1 py-0.5 text-[10px]">companyName</code>{' '}
        (must already exist).
      </p>
      <p className="mt-1.5 text-slate-500">
        Rows with missing required fields are skipped and reported individually.
      </p>
    </div>
  );
}

function ResultPanel({
  result,
  onReset,
}: {
  result: BulkUploadResult;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        <span>
          {result.inserted} deal{result.inserted === 1 ? '' : 's'} created
          {result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
        </span>
      </div>
      {result.errors.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-800">Row errors</p>
          <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto text-[11px] text-amber-900">
            {result.errors.map((e) => (
              <li key={e.row} className="flex gap-2">
                <span className="font-medium tabular-nums">Row {e.row}:</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onReset}
        className="inline-flex items-center gap-1.5 self-start rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        Upload another file
      </button>
    </div>
  );
}

const TEMPLATE_HEADERS = [
  'name',
  'description',
  'stage',
  'amount',
  'currency',
  'expectedCloseDate',
  'companyName',
];
const TEMPLATE_SAMPLE_ROW = [
  'Acme — annual contract',
  'Key blockers: pricing review pending',
  'proposal',
  '50000',
  'USD',
  '2026-08-15',
  'Acme Inc',
];
const TEMPLATE_CSV = `${TEMPLATE_HEADERS.join(',')}\n${TEMPLATE_SAMPLE_ROW.map(csvEscape).join(',')}\n`;
const TEMPLATE_DATA_URL = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
