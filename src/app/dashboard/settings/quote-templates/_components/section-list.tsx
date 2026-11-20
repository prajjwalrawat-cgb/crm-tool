'use client';

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertCircle, GripVertical, Lock, Palette, Trash2 } from 'lucide-react';

import type { QuoteSection } from '@/lib/quotes/template-schema';
import { cn } from '@/lib/utils';

import { selectCls, Toggle } from '../../lead-capture/_components/ui';
import { ADDABLE_TYPES, isLockedSection, SECTION_LABELS, type SectionType } from './section-defaults';

export type Selection = { kind: 'theme' } | { kind: 'section'; id: string };

const rowCls = 'flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[12.5px] transition';
const rowTone = (selected: boolean, hasError: boolean) =>
  cn(
    hasError
      ? 'border-rose-300 bg-rose-50/60 dark:border-rose-500/40 dark:bg-rose-500/10'
      : 'border-slate-200 bg-white dark:border-[#262626] dark:bg-[#0F0F0F]',
    selected && 'ring-2 ring-indigo-500/40',
  );

export function SectionList({
  sections,
  selection,
  onSelect,
  onReorder,
  onToggle,
  onDelete,
  onAdd,
  sectionErrors,
  themeHasErrors,
}: {
  sections: QuoteSection[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onReorder: (next: QuoteSection[]) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onAdd: (type: SectionType) => void;
  sectionErrors: Record<string, string[]>;
  themeHasErrors: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const ids = sections.map((s) => s.id);

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    onReorder(arrayMove(sections, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onSelect({ kind: 'theme' })}
        className={cn(rowCls, rowTone(selection.kind === 'theme', themeHasErrors), 'font-medium text-slate-800 dark:text-[#E4E4E7]')}
      >
        <Palette className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        Theme
        {themeHasErrors ? <AlertCircle className="ml-auto h-3.5 w-3.5 text-rose-600" aria-label="Has errors" /> : null}
      </button>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="space-y-1" aria-label="Sections">
            {sections.map((s) => (
              <SortableSection
                key={s.id}
                section={s}
                selected={selection.kind === 'section' && selection.id === s.id}
                errors={sectionErrors[s.id]}
                onSelect={() => onSelect({ kind: 'section', id: s.id })}
                onToggle={(v) => onToggle(s.id, v)}
                onDelete={() => onDelete(s.id)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <select
        aria-label="Add section"
        className={cn(selectCls, 'text-[12.5px]')}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value as SectionType);
        }}
      >
        <option value="">+ Add section…</option>
        {ADDABLE_TYPES.map((t) => (
          <option key={t} value={t}>
            {SECTION_LABELS[t]}
          </option>
        ))}
      </select>
    </div>
  );
}

function SortableSection({
  section,
  selected,
  errors,
  onSelect,
  onToggle,
  onDelete,
}: {
  section: QuoteSection;
  selected: boolean;
  errors: string[] | undefined;
  onSelect: () => void;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  const locked = isLockedSection(section.type);
  const name = section.title.trim() || SECTION_LABELS[section.type];
  const hasError = !!errors?.length;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(rowCls, rowTone(selected, hasError), isDragging && 'z-10 shadow-md', !section.enabled && 'opacity-60')}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${name}`}
        className="cursor-grab touch-none text-slate-400 hover:text-slate-600 dark:hover:text-[#E4E4E7]"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" title={hasError ? errors.join('\n') : undefined}>
        <span className="block truncate font-medium text-slate-800 dark:text-[#E4E4E7]">{name}</span>
        <span className="block truncate text-[11px] text-slate-500 dark:text-[#A1A1AA]">{SECTION_LABELS[section.type]}</span>
      </button>
      {hasError ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" aria-label="Has errors" /> : null}
      {locked ? (
        <span title="Required: can be moved but not hidden or removed" className="shrink-0 text-slate-400">
          <Lock className="h-3.5 w-3.5" aria-label="Required section" />
        </span>
      ) : (
        <>
          <Toggle checked={section.enabled} onChange={onToggle} label={`Show ${name}`} />
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={onDelete}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </li>
  );
}
