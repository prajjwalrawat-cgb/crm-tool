'use client';

import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { DealDocument, DealDocumentCategory } from '@/db/schema';
import { cn } from '@/lib/utils';

import {
  deleteDealDocumentAction,
  uploadDealDocumentAction,
} from '../document-actions';

const CATEGORY_LABEL: Record<DealDocumentCategory, string> = {
  proposal: 'Proposal',
  contract: 'Contract',
  pricing: 'Pricing',
  other: 'Other',
};

const CATEGORY_BADGE: Record<DealDocumentCategory, string> = {
  proposal: 'bg-indigo-100 text-indigo-700',
  contract: 'bg-emerald-100 text-emerald-700',
  pricing: 'bg-amber-100 text-amber-800',
  other: 'bg-slate-100 text-slate-600',
};

const CATEGORIES: DealDocumentCategory[] = [
  'proposal',
  'contract',
  'pricing',
  'other',
];

export function DealDocumentsCard({
  dealId,
  initialDocuments,
  authorLookup,
  canEdit,
}: {
  dealId: string;
  initialDocuments: DealDocument[];
  authorLookup: Record<string, string>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<DealDocumentCategory>('other');
  const [dragging, setDragging] = useState(false);
  const [pending, startTransition] = useTransition();

  function upload(file: File) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set('dealId', dealId);
      fd.set('category', category);
      fd.set('file', file);
      const result = await uploadDealDocumentAction(fd);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Document uploaded');
      router.refresh();
    });
  }

  function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Upload sequentially so each gets its own row + activity entry.
    Array.from(files).forEach((f) => upload(f));
  }

  function remove(doc: DealDocument) {
    if (!window.confirm(`Delete "${doc.fileName}"? This can't be undone.`)) {
      return;
    }
    startTransition(async () => {
      const result = await deleteDealDocumentAction({ id: doc.id, dealId });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Document deleted');
      router.refresh();
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Documents</h2>
        </div>
        <span className="text-[10px] tabular-nums text-slate-400">
          {initialDocuments.length}
        </span>
      </header>

      {canEdit ? (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-400">
              Category
            </span>
            <select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as DealDocumentCategory)
              }
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              onPick(e.dataTransfer.files);
            }}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-4 text-[12px] transition',
              dragging
                ? 'border-indigo-400 bg-indigo-50 text-indigo-600'
                : 'border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-300 hover:text-indigo-600',
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            Drag &amp; drop or click to upload
            <span className="text-[10px] text-slate-400">
              PDF, image, Office doc or text · max 15 MB
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onPick(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      ) : null}

      {initialDocuments.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[12px] text-slate-500">
          No documents yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100">
          {initialDocuments.map((doc) => {
            const isImage = doc.fileType.startsWith('image/');
            const Icon = isImage ? ImageIcon : FileText;
            return (
              <li key={doc.id} className="flex items-center gap-2 py-2">
                <Icon
                  className="h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <a
                    href={doc.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-[12.5px] font-medium text-slate-800 hover:text-indigo-600"
                  >
                    {doc.fileName}
                  </a>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
                    <span
                      className={cn(
                        'rounded px-1 py-0 font-medium',
                        CATEGORY_BADGE[doc.category],
                      )}
                    >
                      {CATEGORY_LABEL[doc.category]}
                    </span>
                    <span>{formatBytes(doc.sizeBytes)}</span>
                    <span>·</span>
                    <span>{authorLookup[doc.uploadedBy] ?? 'Someone'}</span>
                    <span>·</span>
                    <span>{formatDate(doc.createdAt)}</span>
                  </div>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => remove(doc)}
                    disabled={pending}
                    aria-label="Delete document"
                    className="shrink-0 text-slate-300 hover:text-rose-500 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
