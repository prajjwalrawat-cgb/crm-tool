'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="h-9 w-9 text-indigo-600">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="h-9 w-9 text-indigo-600">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6M9 17h6" />
    </svg>
  );
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
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Takes a chosen/dropped file, switching to the tab that matches its type. */
  function pickFile(f: File | null) {
    if (!f) return;
    setError(null);
    const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv';
    if (f.type.startsWith('image/')) setKind('image');
    else if (isCsv) setKind('csv');
    else {
      setError(kind === 'csv' ? 'Please choose a .csv file.' : IMPORT_MESSAGES.imageType);
      return;
    }
    setFile(f);
  }

  const thumb = useMemo(() => (file && kind === 'image' ? URL.createObjectURL(file) : null), [file, kind]);
  useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [thumb]);

  // Ctrl+V / Cmd+V an image (e.g. a copied screenshot) anywhere on the page.
  useEffect(() => {
    if (busy) return;
    function onPaste(e: ClipboardEvent) {
      const data = e.clipboardData;
      if (!data) return;
      const item = Array.from(data.items).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const blob = item?.getAsFile();
      if (!blob) return;
      // Pasting into a text box when the clipboard also carries text: leave it as a normal text paste.
      const t = e.target as HTMLElement | null;
      const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (editable && data.types.includes('text/plain')) return;
      e.preventDefault();
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const pasted = new File([blob], blob.name && blob.name !== 'image.png' ? blob.name : `pasted-${Date.now()}.${ext}`, {
        type: blob.type,
      });
      setKind('image');
      setFile(pasted);
      setError(null);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [busy]);

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
          <div
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-label={kind === 'csv' ? 'Choose or drop a CSV file' : 'Choose, drop or paste an image'}
            aria-disabled={busy}
            onClick={() => !busy && fileRef.current?.click()}
            onKeyDown={(e) => {
              if (!busy && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) pickFile(e.dataTransfer.files?.[0] ?? null);
            }}
            className={cn(
              'flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-[13px] text-slate-500 outline-none transition-colors',
              'focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-200',
              dragging
                ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/20'
                : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50 dark:border-[#333] dark:hover:bg-[#1a1a1a]',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            <input
              ref={fileRef}
              key={kind}
              type="file"
              className="sr-only"
              tabIndex={-1}
              accept={kind === 'csv' ? '.csv,text/csv' : 'image/png,image/jpeg,image/webp,image/gif'}
              onChange={(e) => {
                pickFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
              disabled={busy}
            />
            {kind === 'image' && thumb ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumb} alt="Selected image" className="max-h-64 rounded-md border border-slate-200" />
                <span className="font-medium text-slate-700 dark:text-slate-300">{file?.name}</span>
                <span>Click, drop or press Ctrl+V to replace it.</span>
              </>
            ) : kind === 'csv' && file ? (
              <>
                <FileIcon />
                <span className="font-medium text-slate-700 dark:text-slate-300">{file.name}</span>
                <span>{formatSize(file.size)} · Click or drop another file to replace it.</span>
              </>
            ) : (
              <>
                <UploadIcon />
                <span className="text-[14px] font-medium text-slate-700 dark:text-slate-300">
                  {dragging ? 'Drop it here' : kind === 'csv' ? 'Drag & drop a CSV file here' : 'Drag & drop an image here'}
                </span>
                <span>
                  or <span className="font-medium text-indigo-700 underline underline-offset-2">browse your files</span>
                  {kind === 'image' ? ', or press Ctrl+V to paste a screenshot' : ''}
                </span>
                <span className="text-[12px] text-slate-400">
                  {kind === 'csv' ? '.csv files only' : 'PNG, JPG, WEBP or GIF'}
                </span>
              </>
            )}
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
