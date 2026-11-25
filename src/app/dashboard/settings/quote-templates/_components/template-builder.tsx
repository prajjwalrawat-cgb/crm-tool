'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useUnsavedChangesWarning } from '@/components/quotes/use-unsaved-changes';
import { saveQuoteTemplateAction } from '@/lib/quotes/actions';
import { quoteTemplateBodySchema, type QuoteSection, type QuoteTemplateBody, type QuoteTheme } from '@/lib/quotes/template-schema';
import { cn } from '@/lib/utils';

import { Badge, Button, Card, inputCls } from '../../lead-capture/_components/ui';
import { newSection, SECTION_LABELS, type SectionType } from './section-defaults';
import { SectionList, type Selection } from './section-list';
import { SectionSettings, type DealFieldOption } from './section-settings';
import { groupTemplateErrors, issuesToFieldErrors, mergeTemplateErrors, NO_ERRORS, type TemplateErrors } from './template-errors';
import { ThemeSettings } from './theme-settings';

const PdfPreview = dynamic(() => import('./pdf-preview'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center rounded-lg border border-slate-200 text-[12px] text-slate-500 dark:border-[#262626] dark:text-[#A1A1AA]">
      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> Loading preview…
    </div>
  ),
});

const snapshotOf = (name: string, body: QuoteTemplateBody) => JSON.stringify({ name, body });

function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="space-y-0.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

export function TemplateBuilder({
  id,
  initialName,
  initialBody,
  isDefault,
  dealCustomFields,
  logoUrl,
}: {
  id: string;
  initialName: string;
  initialBody: QuoteTemplateBody;
  isDefault: boolean;
  dealCustomFields: DealFieldOption[];
  /** Workspace logo as a data URL, for the preview. */
  logoUrl: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initialName);
  const [body, setBody] = useState<QuoteTemplateBody>(initialBody);
  const [saved, setSaved] = useState(() => snapshotOf(initialName, initialBody));
  const [selection, setSelection] = useState<Selection>({ kind: 'theme' });
  const [serverErrors, setServerErrors] = useState<TemplateErrors>(NO_ERRORS);

  const dirty = snapshotOf(name, body) !== saved;
  useUnsavedChangesWarning(dirty, 'You have unsaved changes to this template. Leave without saving?');

  const liveErrors = useMemo(() => {
    const r = quoteTemplateBodySchema.safeParse(body);
    return r.success ? NO_ERRORS : groupTemplateErrors(issuesToFieldErrors(r.error.issues), body.sections.map((s) => s.id));
  }, [body]);
  const errors = mergeTemplateErrors(liveErrors, serverErrors);

  /** Every body edit goes through here; stale server errors are dropped. */
  function editBody(fn: (prev: QuoteTemplateBody) => QuoteTemplateBody) {
    setBody(fn);
    setServerErrors(NO_ERRORS);
  }
  const editSections = (fn: (prev: QuoteSection[]) => QuoteSection[]) => editBody((b) => ({ ...b, sections: fn(b.sections) }));
  const replaceSection = (next: QuoteSection) => editSections((ss) => ss.map((s) => (s.id === next.id ? next : s)));
  const setTheme = (theme: QuoteTheme) => editBody((b) => ({ ...b, theme }));

  function addSection(type: SectionType) {
    const section = newSection(type, new Set(body.sections.map((s) => s.id)));
    editSections((ss) => [...ss, section]);
    setSelection({ kind: 'section', id: section.id });
  }

  function deleteSection(sectionId: string) {
    const s = body.sections.find((x) => x.id === sectionId);
    if (!s) return;
    if (!confirm(`Remove the “${s.title.trim() || SECTION_LABELS[s.type]}” section?`)) return;
    editSections((ss) => ss.filter((x) => x.id !== sectionId));
    if (selection.kind === 'section' && selection.id === sectionId) setSelection({ kind: 'theme' });
  }

  function save() {
    const sentName = name;
    const sentBody = body;
    const sentIds = body.sections.map((s) => s.id);
    startTransition(async () => {
      const res = await saveQuoteTemplateAction({ id, name: sentName, body: sentBody });
      if (!res.ok) {
        const grouped = groupTemplateErrors(res.fieldErrors ?? {}, sentIds);
        setServerErrors(res.fieldErrors ? grouped : { ...grouped, general: [res.error] });
        toast.error(res.error);
        return;
      }
      setSaved(snapshotOf(sentName, sentBody));
      setServerErrors(NO_ERRORS);
      toast.success('Template saved');
    });
  }

  const selected = selection.kind === 'section' ? body.sections.find((s) => s.id === selection.id) : undefined;
  const selectedErrors = selected ? (errors.sections[selected.id] ?? []) : errors.theme;

  return (
    <main className="space-y-4">
      <header className="space-y-3">
        <Link
          href="/dashboard/settings/quote-templates"
          className="inline-flex items-center gap-1 text-[12px] text-slate-500 hover:text-slate-800 dark:text-[#A1A1AA] dark:hover:text-[#FAFAFA]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Quote templates
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="template-name" className="sr-only">
              Template name
            </label>
            <input
              id="template-name"
              className={cn(inputCls, 'text-[15px] font-semibold', errors.name.length && 'border-rose-400')}
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setServerErrors((prev) => ({ ...prev, name: [] }));
              }}
            />
            {errors.name.length ? <p className="mt-1 text-[11.5px] text-rose-600 dark:text-rose-400">{errors.name.join(' ')}</p> : null}
          </div>
          <div className="flex items-center gap-2 pt-1.5">
            {isDefault ? <Badge tone="active">Default</Badge> : null}
            <span className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
            <Button variant="primary" onClick={save} disabled={pending || !dirty}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </div>
        </div>
        <ErrorList errors={errors.general} />
      </header>

      <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.1fr)]">
        <SectionList
          sections={body.sections}
          selection={selection}
          onSelect={setSelection}
          onReorder={(next) => editSections(() => next)}
          onToggle={(sectionId, enabled) => editSections((ss) => ss.map((s) => (s.id === sectionId ? { ...s, enabled } : s)))}
          onDelete={deleteSection}
          onAdd={addSection}
          sectionErrors={errors.sections}
          themeHasErrors={errors.theme.length > 0}
        />

        <Card
          title={selected ? selected.title.trim() || SECTION_LABELS[selected.type] : 'Theme'}
          description={selected ? SECTION_LABELS[selected.type] : 'Fonts, colours, page size and logo for the whole document.'}
          className="self-start"
        >
          <div className="space-y-4">
            <ErrorList errors={selectedErrors} />
            {selected ? (
              <SectionSettings key={selected.id} section={selected} onChange={replaceSection} dealFields={dealCustomFields} />
            ) : (
              <ThemeSettings theme={body.theme} onChange={setTheme} />
            )}
          </div>
        </Card>

        <div className="h-[75vh] xl:sticky xl:top-20">
          <PdfPreview body={body} logoUrl={logoUrl} />
        </div>
      </div>
    </main>
  );
}
