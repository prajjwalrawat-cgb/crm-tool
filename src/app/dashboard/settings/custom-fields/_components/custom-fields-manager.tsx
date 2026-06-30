'use client';

import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { CustomFieldEntity } from '@/db/schema';
import type { AdminCustomField } from '@/lib/custom-fields/queries';
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@/lib/custom-fields/types';
import { cn } from '@/lib/utils';

import {
  createCustomFieldAction,
  moveCustomFieldAction,
  setCustomFieldArchivedAction,
  updateCustomFieldAction,
} from '../actions';

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown',
  boolean: 'Checkbox',
};

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

export function CustomFieldsManager({
  entityType,
  entityLabel,
  initial,
}: {
  entityType: CustomFieldEntity;
  entityLabel: string;
  initial: AdminCustomField[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = initial.filter((f) => !f.archived);
  const archived = initial.filter((f) => f.archived);

  // Add-field form state
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [required, setRequired] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        if (okMsg) toast.success(okMsg);
        router.refresh();
      } else {
        toast.error(res.error ?? 'Something went wrong');
      }
    });
  }

  function addField() {
    if (!label.trim()) {
      toast.error('Give the field a label');
      return;
    }
    const options =
      fieldType === 'select'
        ? optionsText.split('\n').map((s) => s.trim()).filter(Boolean)
        : [];
    run(
      () =>
        createCustomFieldAction({ entityType, label, fieldType, options, required }),
      'Field added',
    );
    setLabel('');
    setFieldType('text');
    setOptionsText('');
    setRequired(false);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-1 py-1">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Custom fields</h1>
        <p className="mt-0.5 text-[12px] text-slate-500">
          Define extra fields for {entityLabel.toLowerCase()}s. They appear on the create &amp; edit
          forms and the detail page.
        </p>
      </header>

      {/* Add field */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-slate-900">Add a field</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-600">Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Region" className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-600">Type</span>
            <select value={fieldType} onChange={(e) => setFieldType(e.target.value as CustomFieldType)} className={inputCls}>
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
        </div>
        {fieldType === 'select' ? (
          <label className="mt-3 block space-y-1">
            <span className="text-[12px] font-medium text-slate-600">Options (one per line)</span>
            <textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} placeholder={'North\nSouth\nEast\nWest'} className={inputCls} />
          </label>
        ) : null}
        <div className="mt-3 flex items-center justify-between">
          {fieldType !== 'boolean' ? (
            <label className="inline-flex items-center gap-2 text-[12.5px] text-slate-700">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Required
            </label>
          ) : <span />}
          <button
            type="button"
            onClick={addField}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-indigo-500 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Add field
          </button>
        </div>
      </section>

      {/* Active fields */}
      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold text-slate-900">Fields ({active.length})</h2>
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-[12px] text-slate-500">
            No custom fields yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {active.map((f, i) => (
              <li key={f.id} className="px-3 py-2.5">
                {editingId === f.id ? (
                  <EditRow
                    field={f}
                    pending={pending}
                    onCancel={() => setEditingId(null)}
                    onSave={(payload) =>
                      run(async () => {
                        const res = await updateCustomFieldAction({ id: f.id, ...payload });
                        if (res.ok) setEditingId(null);
                        return res;
                      }, 'Field updated')
                    }
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col">
                      <button
                        type="button"
                        disabled={pending || i === 0}
                        onClick={() => run(() => moveCustomFieldAction(f.id, 'up'))}
                        aria-label="Move up"
                        className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        disabled={pending || i === active.length - 1}
                        onClick={() => run(() => moveCustomFieldAction(f.id, 'down'))}
                        aria-label="Move down"
                        className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium text-slate-900">{f.label}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                          {TYPE_LABEL[f.fieldType]}
                        </span>
                        {f.required ? (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Required</span>
                        ) : null}
                      </div>
                      <span className="text-[11px] text-slate-400">
                        key: {f.key}
                        {f.fieldType === 'select' && f.options.length ? ` · ${f.options.join(', ')}` : ''}
                      </span>
                    </div>
                    <button type="button" onClick={() => setEditingId(f.id)} aria-label="Edit" className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-slate-50">
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => setCustomFieldArchivedAction(f.id, true), 'Field archived')}
                      aria-label="Archive"
                      className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Archived */}
      {archived.length > 0 ? (
        <section className="mt-6 space-y-2">
          <h2 className="text-[13px] font-semibold text-slate-500">Archived ({archived.length})</h2>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-slate-50/40">
            {archived.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 text-[13px] text-slate-500 line-through">{f.label}</span>
                <span className="text-[10px] uppercase tracking-wide text-slate-400">{TYPE_LABEL[f.fieldType]}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => setCustomFieldArchivedAction(f.id, false), 'Field restored')}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                >
                  <Undo2 className="h-3 w-3" aria-hidden />
                  Restore
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-400">
            Archived fields stop appearing on forms but their saved values are kept.
          </p>
        </section>
      ) : null}
    </main>
  );
}

function EditRow({
  field,
  pending,
  onCancel,
  onSave,
}: {
  field: AdminCustomField;
  pending: boolean;
  onCancel: () => void;
  onSave: (payload: { label: string; options: string[]; required: boolean }) => void;
}) {
  const [label, setLabel] = useState(field.label);
  const [optionsText, setOptionsText] = useState(field.options.join('\n'));
  const [required, setRequired] = useState(field.required);

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={inputCls} />
        <div className={cn('flex items-center gap-2', field.fieldType === 'boolean' && 'opacity-50')}>
          {field.fieldType !== 'boolean' ? (
            <label className="inline-flex items-center gap-2 text-[12.5px] text-slate-700">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Required
            </label>
          ) : (
            <span className="text-[11px] text-slate-400">Checkbox · {TYPE_LABEL[field.fieldType]}</span>
          )}
        </div>
      </div>
      {field.fieldType === 'select' ? (
        <textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} placeholder="One option per line" className={inputCls} />
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-slate-200 px-3 py-1.5 text-[12.5px] hover:bg-slate-50">Cancel</button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            onSave({
              label,
              options: optionsText.split('\n').map((s) => s.trim()).filter(Boolean),
              required,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Save
        </button>
      </div>
    </div>
  );
}
