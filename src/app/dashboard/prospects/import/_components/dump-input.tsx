'use client';

import { useEffect, useMemo, useState } from 'react';

import type { DumpRow } from '@/lib/prospects/import/csv-map';
import type { DedupHint } from '@/lib/prospects/import/dedup-hints';
import { cn } from '@/lib/utils';

import { Button, Card, Field, inputCls } from '../../../settings/lead-capture/_components/ui';
import { PreviewGrid } from './preview-grid';

type Kind = 'text' | 'csv' | 'image';
type Parsed = { importId: string; rows: DumpRow[]; dropped: number; hints: DedupHint[]; sourceTag: string };

const TABS: { kind: Kind; label: string }[] = [
  { kind: 'text', label: 'Paste text' },
  { kind: 'csv', label: 'CSV file' },
  { kind: 'image', label: 'Image' },
];

export function DumpInput({
  sourceTags,
  offerings,
}: {
  sourceTags: string[];
  offerings: { id: string; name: string }[];
}) {
  const [sourceTag, setSourceTag] = useState('');
  const [kind, setKind] = useState<Kind>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);

  const thumb = useMemo(() => (file && kind === 'image' ? URL.createObjectURL(file) : null), [file, kind]);
  useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [thumb]);

  const ready = sourceTag.trim() && (kind === 'text' ? text.trim() : file);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('sourceTag', sourceTag.trim());
      fd.set('kind', kind);
      if (kind === 'text') fd.set('text', text);
      else if (file) fd.set('file', file);
      const res = await fetch('/api/prospects/import', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => null)) as
        | { importId: string; rows: DumpRow[]; dropped: number; hints: DedupHint[]; error?: string }
        | { error: string }
        | null;
      if (!res.ok || !body || 'error' in body) {
        setError((body && 'error' in body && body.error) || 'Could not read prospects. Try again.');
        return;
      }
      setParsed({ ...body, sourceTag: sourceTag.trim() });
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (parsed) {
    return (
      <PreviewGrid
        key={parsed.importId}
        importId={parsed.importId}
        sourceTag={parsed.sourceTag}
        initialRows={parsed.rows}
        dropped={parsed.dropped}
        hints={parsed.hints}
        offerings={offerings}
        onDiscarded={() => setParsed(null)}
      />
    );
  }

  return (
    <Card>
      <div className="space-y-4">
        <Field label="Source tag *" htmlFor="dump-source" hint="Where this list came from, e.g. Pune expo 2026.">
          <input
            id="dump-source"
            list="dump-source-tags"
            className={inputCls}
            value={sourceTag}
            maxLength={80}
            onChange={(e) => setSourceTag(e.target.value)}
            disabled={busy}
          />
          <datalist id="dump-source-tags">
            {sourceTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>

        <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-[#262626]">
          {TABS.map((t) => (
            <button
              key={t.kind}
              type="button"
              role="tab"
              aria-selected={kind === t.kind}
              disabled={busy}
              onClick={() => {
                setKind(t.kind);
                setFile(null);
                setError(null);
              }}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium',
                kind === t.kind
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {kind === 'text' ? (
          <textarea
            aria-label="Paste text"
            className={cn(inputCls, 'min-h-48')}
            placeholder="Paste meeting notes, a WhatsApp list, visiting card text..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
        ) : (
          <div className="space-y-2">
            <input
              key={kind}
              type="file"
              aria-label={kind === 'csv' ? 'CSV file' : 'Image'}
              accept={kind === 'csv' ? '.csv,text/csv' : 'image/png,image/jpeg,image/webp,image/gif'}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              className="block text-[13px]"
            />
            {kind === 'image' && thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="Selected upload" className="max-h-48 rounded-md border border-slate-200" />
            ) : null}
          </div>
        )}

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <Button variant="primary" onClick={submit} disabled={busy || !ready}>
          {busy ? 'Reading…' : 'Read prospects'}
        </Button>
      </div>
    </Card>
  );
}
