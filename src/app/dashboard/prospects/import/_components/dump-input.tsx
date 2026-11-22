'use client';

import { useEffect, useMemo, useState } from 'react';

import type { DumpRow } from '@/lib/prospects/import/csv-map';
import type { DedupHint } from '@/lib/prospects/import/dedup-hints';
import {
  DUMP_IMAGE_TYPES,
  IMPORT_MESSAGES,
  MAX_CSV_BYTES,
  MAX_DUMP_CHARS,
  MAX_IMAGE_BYTES,
} from '@/lib/prospects/import/limits';
import { cn } from '@/lib/utils';

import { Button, Card, Field, inputCls } from '../../../settings/lead-capture/_components/ui';
import { PreviewGrid } from './preview-grid';

type Kind = 'text' | 'csv' | 'image';
type Parsed = { importId: string; rows: DumpRow[]; dropped: number; capped: number; hints: DedupHint[]; sourceTag: string };

const TOO_SLOW = 'This dump took too long — split it into smaller parts and try again.';

/** Longest image edge sent to the server (larger photos are scaled down first). */
const MAX_EDGE = 1568;
/** Images within MAX_EDGE and this size are sent as they are. */
const KEEP_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

/**
 * Scales a photo down to MAX_EDGE on its long side and re-encodes it as JPEG,
 * so phone photos stay well under the upload limits. Images already within
 * MAX_EDGE and KEEP_BYTES are returned unchanged, as is anything the browser
 * can't decode (the server checks it).
 */
async function prepareImage(file: File): Promise<File> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (long <= MAX_EDGE && file.size <= KEEP_BYTES) return file;
    const scale = Math.min(1, MAX_EDGE / long);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    let blob: Blob | null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.fillStyle = '#fff'; // JPEG has no transparency
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    }
    if (!blob) return file;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'image'}.jpg`, { type: 'image/jpeg' });
  } finally {
    bmp.close();
  }
}

/** The server's own size/type checks, run in the browser first with the same messages. */
function precheck(kind: Kind, text: string, file: File | null): string | null {
  if (kind === 'text') {
    const t = text.trim();
    if (!t) return IMPORT_MESSAGES.emptyText;
    return t.length > MAX_DUMP_CHARS ? IMPORT_MESSAGES.textTooLong : null;
  }
  if (!file) return IMPORT_MESSAGES.noFile;
  if (kind === 'csv') return file.size > MAX_CSV_BYTES ? IMPORT_MESSAGES.csvTooLarge : null;
  return (DUMP_IMAGE_TYPES as readonly string[]).includes(file.type.toLowerCase()) ? null : IMPORT_MESSAGES.imageType;
}

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
    const problem = precheck(kind, text, file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('sourceTag', sourceTag.trim());
      fd.set('kind', kind);
      if (kind === 'text') fd.set('text', text);
      else if (file) {
        const upload = kind === 'image' ? await prepareImage(file) : file;
        if (kind === 'image' && upload.size > MAX_IMAGE_BYTES) {
          setError(IMPORT_MESSAGES.imageTooLarge);
          return;
        }
        fd.set('file', upload);
      }
      const res = await fetch('/api/prospects/import', { method: 'POST', body: fd });
      const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
      const body = (isJson ? await res.json().catch(() => null) : null) as
        | { importId: string; rows: DumpRow[]; dropped: number; capped?: number; hints: DedupHint[]; error?: string }
        | { error: string }
        | null;
      // No JSON back (a platform timeout page, a 502/504 from the proxy): the dump took too long.
      if (!body) {
        setError(TOO_SLOW);
        return;
      }
      if (!res.ok || 'error' in body) {
        setError((body && 'error' in body && body.error) || 'Could not read prospects. Try again.');
        return;
      }
      setParsed({ ...body, capped: body.capped ?? 0, sourceTag: sourceTag.trim() });
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
        capped={parsed.capped}
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
