'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type { DumpRow } from '@/lib/prospects/import/csv-map';
import type { DedupHint } from '@/lib/prospects/import/dedup-hints';
import { IMPORT_MESSAGES, MAX_DUMP_ROWS } from '@/lib/prospects/import/limits';
import { prospectInputSchema, SIZE_BANDS } from '@/lib/prospects/rules';
import { cn } from '@/lib/utils';

import { Button, Card } from '../../../settings/lead-capture/_components/ui';
import { confirmImportAction, discardImportAction } from '../../actions';

type Row = DumpRow & { key: number; tags: string };
type TextField =
  | 'companyName'
  | 'contactName'
  | 'contactDesignation'
  | 'contactEmail'
  | 'contactPhone'
  | 'city'
  | 'state'
  | 'industry';

type Props = {
  importId: string;
  sourceTag: string;
  initialRows: DumpRow[];
  dropped: number;
  /** Rows past MAX_DUMP_ROWS that were not kept. */
  capped: number;
  hints: DedupHint[];
  offerings: { id: string; name: string }[];
  onDiscarded: () => void;
};

const FAILED = 'Something went wrong. Try again.';

const HINT_PREFIX: Record<DedupHint['kind'], string> = {
  prospect: 'Already a prospect',
  company: 'Company exists',
  contact: 'Contact exists',
};

const HEADERS = ['Company *', 'Contact', 'Designation', 'Email', 'Phone', 'City', 'State', 'Industry', 'Size', 'Product fit', 'Tags', ''];

const cellCls =
  'w-full min-w-[7rem] rounded border border-slate-200 bg-white px-1.5 py-1 text-[12.5px] text-slate-900 outline-none focus:border-indigo-500 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#FAFAFA]';
const badCls = 'border-red-500 ring-1 ring-red-500';

/** The row as the server expects it: no grid-only fields, tags split, source tag added. */
function toInput(r: Row, sourceTag: string) {
  const rest: Record<string, unknown> = { ...r };
  delete rest.key;
  delete rest.tags;
  delete rest.confidence;
  delete rest.note;
  return {
    ...rest,
    clusterTags: r.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    sourceTag,
  };
}

function invalidFields(r: Row, sourceTag: string): Set<string> {
  const res = prospectInputSchema.safeParse(toInput(r, sourceTag));
  const bad = new Set<string>();
  if (!res.success) {
    for (const issue of res.error.issues) {
      const f = String(issue.path[0] ?? '');
      bad.add(f === 'clusterTags' ? 'tags' : f);
    }
  }
  return bad;
}

export function PreviewGrid({ importId, sourceTag, initialRows, dropped, capped, hints, offerings, onDiscarded }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() =>
    initialRows.map((r, i) => ({ ...r, key: i, tags: (r.clusterTags ?? []).join(', ') })),
  );
  const [serverErrors, setServerErrors] = useState<Map<number, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server says the import was already confirmed or discarded.
  const [done, setDone] = useState(false);

  // Hints and server row errors are indexed by the original row position, which
  // is what `key` keeps even after rows are deleted.
  const hintsByKey = useMemo(() => {
    const m = new Map<number, DedupHint[]>();
    for (const h of hints) m.set(h.index, [...(m.get(h.index) ?? []), h]);
    return m;
  }, [hints]);

  const invalid = useMemo(() => new Map(rows.map((r) => [r.key, invalidFields(r, sourceTag)])), [rows, sourceTag]);
  const anyInvalid = [...invalid.values()].some((s) => s.size > 0);

  function patch(key: number, p: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setServerErrors((m) => {
      if (!m.has(key)) return m;
      const n = new Map(m);
      n.delete(key);
      return n;
    });
  }

  /** Shows a failure; an import someone already confirmed or discarded also gets a link to the board. */
  function fail(message: string) {
    setError(message);
    if (message === IMPORT_MESSAGES.alreadyDone) setDone(true);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    setServerErrors(new Map());
    const sent = rows;
    try {
      const r = await confirmImportAction(
        importId,
        sent.map((row) => toInput(row, sourceTag)),
      );
      if (r.ok) {
        // Stay busy: the board is loading.
        router.push(`/dashboard/prospects?source=${encodeURIComponent(sourceTag)}`);
        return;
      }
      fail(r.message);
      if ('rowErrors' in r && r.rowErrors) {
        // rowErrors index into the array we sent, not the original positions.
        const m = new Map<number, string>();
        for (const e of r.rowErrors) {
          const row = sent[e.index];
          if (row) m.set(row.key, e.message);
        }
        setServerErrors(m);
      }
    } catch {
      setError(FAILED);
    }
    setBusy(false);
  }

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      const r = await discardImportAction(importId);
      if (r.ok) {
        onDiscarded();
        return;
      }
      fail(r.message);
    } catch {
      setError(FAILED);
    }
    setBusy(false);
  }

  const textCell = (r: Row, field: TextField, label: string) => (
    <input
      aria-label={label}
      className={cn(cellCls, invalid.get(r.key)?.has(field) && badCls)}
      value={r[field] ?? ''}
      onChange={(e) => patch(r.key, { [field]: e.target.value } as Partial<Row>)}
      disabled={busy}
    />
  );

  return (
    <Card>
      <div className="space-y-3">
        {capped > 0 ? (
          <p role="status" className="text-[12px] text-slate-500">
            Only the first {MAX_DUMP_ROWS} rows were kept.
          </p>
        ) : null}
        {dropped > 0 ? (
          <p role="status" className="text-[12px] text-slate-500">
            {dropped} unreadable {dropped === 1 ? 'entry was' : 'entries were'} skipped.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-slate-600">No prospects left. Discard to start over.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {HEADERS.map((h, i) => (
                    <th key={i} className="px-1.5 py-2 text-left text-[11.5px] font-medium text-slate-500">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const low = r.confidence < 0.6;
                  const bad = invalid.get(r.key);
                  const srvErr = serverErrors.get(r.key);
                  return (
                    <tr key={r.key} className={cn('border-t border-slate-100 align-top', low && 'bg-yellow-50')}>
                      <td className="p-1">
                        {textCell(r, 'companyName', 'Company')}
                        {low && r.note ? <p className="mt-1 text-[11.5px] text-yellow-800">{r.note}</p> : null}
                        {(hintsByKey.get(r.key) ?? []).map((h, i) => (
                          <span
                            key={i}
                            className="mt-1 mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800"
                          >
                            {HINT_PREFIX[h.kind]}: {h.label}
                          </span>
                        ))}
                        {srvErr ? <p className="mt-1 text-[11.5px] text-red-700">{srvErr}</p> : null}
                      </td>
                      <td className="p-1">{textCell(r, 'contactName', 'Contact')}</td>
                      <td className="p-1">{textCell(r, 'contactDesignation', 'Designation')}</td>
                      <td className="p-1">{textCell(r, 'contactEmail', 'Email')}</td>
                      <td className="p-1">{textCell(r, 'contactPhone', 'Phone')}</td>
                      <td className="p-1">{textCell(r, 'city', 'City')}</td>
                      <td className="p-1">{textCell(r, 'state', 'State')}</td>
                      <td className="p-1">{textCell(r, 'industry', 'Industry')}</td>
                      <td className="p-1">
                        <select
                          aria-label="Size"
                          className={cn(cellCls, bad?.has('sizeBand') && badCls)}
                          value={r.sizeBand ?? ''}
                          onChange={(e) => patch(r.key, { sizeBand: (e.target.value || null) as Row['sizeBand'] })}
                          disabled={busy}
                        >
                          <option value="">-</option>
                          {SIZE_BANDS.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <select
                          aria-label="Product fit"
                          className={cn(cellCls, bad?.has('productFitOfferingId') && badCls)}
                          value={r.productFitOfferingId ?? ''}
                          onChange={(e) => patch(r.key, { productFitOfferingId: e.target.value || null })}
                          disabled={busy}
                        >
                          <option value="">-</option>
                          {offerings.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <input
                          aria-label="Tags"
                          className={cn(cellCls, bad?.has('tags') && badCls)}
                          value={r.tags}
                          onChange={(e) => patch(r.key, { tags: e.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td className="p-1">
                        <button
                          type="button"
                          aria-label="Delete row"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                          disabled={busy}
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            {done ? (
              <>
                {' '}
                <Link href="/dashboard/prospects" className="font-medium underline">
                  View board
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <p className="text-[13px] text-slate-700">
            {rows.length} {rows.length === 1 ? 'prospect' : 'prospects'} will be added to Dump with source {sourceTag}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={discard} disabled={busy || done}>
              Discard
            </Button>
            <Button variant="primary" onClick={confirm} disabled={busy || done || rows.length === 0 || anyInvalid}>
              {busy ? 'Working…' : 'Confirm'}
            </Button>
          </div>
        </footer>
      </div>
    </Card>
  );
}
