'use client';

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Code2, ExternalLink, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { deleteCaptureFormAction, saveCaptureFormAction, setCaptureFormPublishedAction } from '../../lead-capture/actions';
import { Badge, Button, Card, CodeBlock, EmptyState, Field, inputCls, selectCls, Toggle } from '../../lead-capture/_components/ui';

type FieldType = 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox';
type FormField = { key: string; label: string; type: FieldType; required?: boolean; options?: string[] };
export type FormView = {
  id: string;
  sourceId: string;
  slug: string;
  title: string;
  fields: FormField[];
  thankYouMessage: string | null;
  redirectUrl: string | null;
  consentText: string | null;
  accent: string;
  isPublished: boolean;
};

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  email: 'Email',
  tel: 'Phone',
  textarea: 'Long text',
  select: 'Dropdown',
  checkbox: 'Checkbox',
};

/** Suggested keys so submissions map to lead fields without a source mapping. */
const KEY_PRESETS: Array<{ key: string; label: string; type: FieldType; required?: boolean }> = [
  { key: 'name', label: 'Your name', type: 'text', required: true },
  { key: 'phone', label: 'Mobile number', type: 'tel', required: true },
  { key: 'email', label: 'Work email', type: 'email' },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'product', label: 'What are you looking for?', type: 'text' },
  { key: 'message', label: 'Requirement details', type: 'textarea' },
];

const DEFAULT_CONSENT =
  'I agree to be contacted by phone, email or WhatsApp about my enquiry. My details will be used only for this purpose.';

const blankForm = (sourceId: string): FormView => ({
  id: '',
  sourceId,
  slug: 'enquiry',
  title: 'Send us an enquiry',
  fields: KEY_PRESETS.slice(0, 4).map((f) => ({ ...f })),
  thankYouMessage: 'Thank you — our team will call you shortly.',
  redirectUrl: null,
  consentText: DEFAULT_CONSENT,
  accent: '#4f46e5',
  isPublished: false,
});

export function FormsManager({
  origin,
  tenantSlug,
  sources,
  forms,
}: {
  origin: string;
  tenantSlug: string;
  sources: Array<{ id: string; name: string; allowedOrigins: string[] }>;
  forms: FormView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<FormView | null>(null);
  const [embedFor, setEmbedFor] = useState<FormView | null>(null);
  const formSources = sources;

  return (
    <div className="space-y-4">
      <Card
        title="Forms"
        actions={
          <Button
            variant="primary"
            disabled={formSources.length === 0}
            title={formSources.length === 0 ? 'Create a lead source first' : undefined}
            onClick={() => setEditing(blankForm(formSources[0]!.id))}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> New form
          </Button>
        }
      >
        {formSources.length === 0 ? (
          <EmptyState title="Create a lead source first">Forms deliver into a lead source (Settings › Lead sources).</EmptyState>
        ) : forms.length === 0 ? (
          <EmptyState title="No forms yet" />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
            {forms.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-[12rem] flex-1">
                  <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{f.title}</div>
                  <div className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                    /{f.slug} · {f.fields.length} fields · into {sources.find((s) => s.id === f.sourceId)?.name ?? 'unknown source'}
                  </div>
                </div>
                <Badge tone={f.isPublished ? 'active' : 'inactive'}>{f.isPublished ? 'Published' : 'Draft'}</Badge>
                <label className="flex items-center gap-2 text-[12px]">
                  <Toggle
                    label={`Publish ${f.title}`}
                    checked={f.isPublished}
                    disabled={pending}
                    onChange={(v) =>
                      startTransition(async () => {
                        const r = await setCaptureFormPublishedAction(f.id, v);
                        if (!r.ok) return void toast.error(r.message);
                        toast.success(v ? 'Published' : 'Unpublished — the hosted page and embed now show “unavailable”');
                        router.refresh();
                      })
                    }
                  />
                  Publish
                </label>
                <Button onClick={() => setEmbedFor(f)}>
                  <Code2 className="h-3.5 w-3.5" aria-hidden /> Embed
                </Button>
                <Button onClick={() => setEditing(f)}>Edit</Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${f.title}`}
                  onClick={() => {
                    if (!confirm(`Delete “${f.title}”? Websites embedding it will show “unavailable”.`)) return;
                    startTransition(async () => {
                      const r = await deleteCaptureFormAction(f.id);
                      if (!r.ok) return void toast.error(r.message);
                      toast.success('Form deleted');
                      router.refresh();
                    });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {embedFor ? (
        <EmbedPanel
          form={embedFor}
          origin={origin}
          tenantSlug={tenantSlug}
          allowedOrigins={sources.find((s) => s.id === embedFor.sourceId)?.allowedOrigins ?? []}
          onClose={() => setEmbedFor(null)}
        />
      ) : null}

      {editing ? (
        <FormEditor
          key={editing.id || 'new'}
          initial={editing}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function EmbedPanel({
  form,
  origin,
  tenantSlug,
  allowedOrigins,
  onClose,
}: {
  form: FormView;
  origin: string;
  tenantSlug: string;
  allowedOrigins: string[];
  onClose: () => void;
}) {
  const hosted = `${origin}/f/${tenantSlug}/${form.slug}`;
  const snippet = `<div data-saleinx-form="${tenantSlug}/${form.slug}"></div>\n<script src="${origin}/embed/form.js" async></script>`;
  return (
    <Card title={`Share “${form.title}”`} actions={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        {!form.isPublished ? <p className="text-[12px] text-amber-700 dark:text-amber-300">This form is a draft — publish it before sharing.</p> : null}
        <Field label="Hosted page">
          <div className="flex items-center gap-2">
            <CodeBlock code={hosted} />
            <a href={hosted} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-indigo-600 hover:underline dark:text-indigo-400">
              Open <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </Field>
        <Field
          label="Embed on your website"
          hint={
            allowedOrigins.length
              ? `Allowed origins: ${allowedOrigins.join(', ')}`
              : 'Add your website’s origin (e.g. https://www.yourcompany.com) to this form’s lead source under Allowed origins, or embedded submissions will be refused.'
          }
        >
          <CodeBlock code={snippet} />
        </Field>
      </div>
    </Card>
  );
}

function SortableField({
  id,
  field,
  onChange,
  onRemove,
}: {
  id: string;
  field: FormField;
  onChange: (f: FormField) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('rounded-lg border border-slate-200 bg-white p-2 dark:border-[#262626] dark:bg-[#111111]', isDragging && 'z-10 shadow-lg')}
    >
      <div className="flex items-start gap-2">
        <button type="button" className="mt-2 cursor-grab text-slate-400" aria-label={`Drag ${field.label}`} {...attributes} {...listeners}>
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="grid flex-1 gap-1.5 sm:grid-cols-[1fr_8rem_7rem_auto]">
          <input className={inputCls} aria-label="Label" value={field.label} onChange={(e) => onChange({ ...field, label: e.target.value })} />
          <select className={selectCls} aria-label="Type" value={field.type} onChange={(e) => onChange({ ...field, type: e.target.value as FieldType })}>
            {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            className={cn(inputCls, 'font-mono text-[12px]')}
            aria-label="Field key"
            value={field.key}
            onChange={(e) => onChange({ ...field, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '') })}
          />
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ ...field, required: e.target.checked })} /> Required
          </label>
          {field.type === 'select' ? (
            <input
              className={cn(inputCls, 'sm:col-span-4')}
              aria-label="Options"
              placeholder="Options, comma-separated"
              value={(field.options ?? []).join(', ')}
              onChange={(e) => onChange({ ...field, options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })}
            />
          ) : null}
        </div>
        <Button variant="ghost" aria-label={`Remove ${field.label}`} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

function FormEditor({
  initial,
  sources,
  onClose,
  onSaved,
}: {
  initial: FormView;
  sources: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(initial);
  // Stable ids for drag-and-drop, independent of the editable key.
  const [ids, setIds] = useState(() => initial.fields.map((_, i) => `f${i}-${Math.random().toString(36).slice(2, 7)}`));
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const set = <K extends keyof FormView>(k: K, v: FormView[K]) => setF((x) => ({ ...x, [k]: v }));

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    setIds(arrayMove(ids, from, to));
    set('fields', arrayMove(f.fields, from, to));
  }

  function addField(preset?: (typeof KEY_PRESETS)[number]) {
    const used = new Set(f.fields.map((x) => x.key));
    const base = preset ?? { key: 'field', label: 'New field', type: 'text' as FieldType };
    let key = base.key;
    for (let n = 2; used.has(key); n++) key = `${base.key}_${n}`;
    set('fields', [...f.fields, { ...base, key }]);
    setIds((x) => [...x, `f${x.length}-${Math.random().toString(36).slice(2, 7)}`]);
  }

  function save() {
    startTransition(async () => {
      const r = await saveCaptureFormAction(initial.id || null, {
        sourceId: f.sourceId,
        slug: f.slug,
        title: f.title,
        fields: f.fields,
        thankYouMessage: f.thankYouMessage || null,
        redirectUrl: f.redirectUrl || null,
        consentText: f.consentText || null,
        theme: { accent: f.accent },
      });
      if (!r.ok) return void toast.error(r.message);
      toast.success('Form saved');
      onSaved();
    });
  }

  const unusedPresets = KEY_PRESETS.filter((p) => !f.fields.some((x) => x.key === p.key));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <Card
        title={initial.id ? `Edit “${initial.title}”` : 'New form'}
        actions={
          <>
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              Save form
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Title" htmlFor="form-title">
            <input id="form-title" className={inputCls} value={f.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="URL slug" hint="Lowercase letters, numbers and dashes." htmlFor="form-slug">
            <input
              id="form-slug"
              className={cn(inputCls, 'font-mono text-[12px]')}
              value={f.slug}
              onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            />
          </Field>
          <Field label="Delivers into source" htmlFor="form-source">
            <select id="form-source" className={selectCls} value={f.sourceId} onChange={(e) => set('sourceId', e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Button colour" htmlFor="form-accent">
            <input id="form-accent" type="color" className="h-9 w-16 rounded border border-slate-200" value={f.accent} onChange={(e) => set('accent', e.target.value)} />
          </Field>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Fields (drag to reorder)</div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ul className="space-y-1.5">
                {f.fields.map((field, i) => (
                  <SortableField
                    key={ids[i]}
                    id={ids[i]!}
                    field={field}
                    onChange={(nf) => set('fields', f.fields.map((x, j) => (j === i ? nf : x)))}
                    onRemove={() => {
                      set('fields', f.fields.filter((_, j) => j !== i));
                      setIds((x) => x.filter((_, j) => j !== i));
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {unusedPresets.map((p) => (
              <Button key={p.key} onClick={() => addField(p)}>
                <Plus className="h-3 w-3" aria-hidden /> {p.label}
              </Button>
            ))}
            <Button onClick={() => addField()}>
              <Plus className="h-3 w-3" aria-hidden /> Custom field
            </Button>
          </div>
          <p className="mt-1 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            Keys like name, phone, email, company, city, state, product and message map straight onto the lead. Any other key is kept on the raw payload; map it to a custom field on the source.
          </p>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="Consent statement" hint="Shown with a required checkbox. Leave empty for no consent checkbox." htmlFor="form-consent">
            <textarea id="form-consent" className={cn(inputCls, 'min-h-[72px]')} value={f.consentText ?? ''} onChange={(e) => set('consentText', e.target.value)} />
          </Field>
          <div className="space-y-3">
            <Field label="Thank-you message" htmlFor="form-thanks">
              <input id="form-thanks" className={inputCls} value={f.thankYouMessage ?? ''} onChange={(e) => set('thankYouMessage', e.target.value)} />
            </Field>
            <Field label="Redirect after submit (optional)" htmlFor="form-redirect">
              <input id="form-redirect" className={inputCls} placeholder="https://…" value={f.redirectUrl ?? ''} onChange={(e) => set('redirectUrl', e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Live preview" description="Approximately how the embed renders.">
        <FormPreview form={f} />
      </Card>
    </div>
  );
}

function FormPreview({ form }: { form: FormView }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 text-slate-900" style={{ ['--a' as string]: form.accent }}>
      <h3 className="mb-3 text-[18px] font-semibold">{form.title || 'Untitled form'}</h3>
      {form.fields.map((fl, i) =>
        fl.type === 'checkbox' ? (
          <label key={i} className="mt-3 flex items-start gap-2 text-[12.5px] text-slate-600">
            <input type="checkbox" disabled /> {fl.label}
            {fl.required ? <span className="text-rose-700">*</span> : null}
          </label>
        ) : (
          <div key={i}>
            <div className="mt-2.5 mb-1 text-[13px] font-medium">
              {fl.label}
              {fl.required ? <span className="text-rose-700"> *</span> : null}
            </div>
            {fl.type === 'textarea' ? (
              <div className="h-20 rounded-lg border border-slate-300" />
            ) : fl.type === 'select' ? (
              <div className="rounded-lg border border-slate-300 px-3 py-2 text-[13px] text-slate-400">Select…</div>
            ) : (
              <div className="h-9 rounded-lg border border-slate-300" />
            )}
          </div>
        ),
      )}
      {form.consentText ? (
        <label className="mt-3 flex items-start gap-2 text-[12.5px] text-slate-600">
          <input type="checkbox" disabled className="mt-0.5" /> {form.consentText}
        </label>
      ) : null}
      <div className="mt-4 rounded-lg py-2.5 text-center text-[14px] font-semibold text-white" style={{ background: form.accent }}>
        Submit
      </div>
    </div>
  );
}
