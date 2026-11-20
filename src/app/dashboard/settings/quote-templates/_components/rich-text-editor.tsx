'use client';

import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Bold, Heading2, Heading3, Italic, List, ListOrdered } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import type { RichTextDoc } from '@/lib/quotes/rich-text';
import { quoteRichTextExtensions } from '@/lib/quotes/rich-text-extensions';
import { PLACEHOLDERS } from '@/lib/quotes/template-schema';
import { cn } from '@/lib/utils';

import { selectCls } from '../../lead-capture/_components/ui';

/**
 * TipTap editor restricted to the RichTextDoc subset, plus a picker that
 * inserts `placeholder` nodes. Uncontrolled after mount: re-key it to load a
 * different document.
 */
export function RichTextEditor({
  value,
  onChange,
  ariaLabel,
}: {
  value: RichTextDoc;
  onChange: (doc: RichTextDoc) => void;
  ariaLabel: string;
}) {
  // The editor keeps its first options; read the latest callback through a ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: quoteRichTextExtensions(),
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        class:
          'min-h-[120px] px-3 py-2 text-[13px] leading-relaxed text-slate-900 outline-none dark:text-[#FAFAFA] [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-1',
      },
    },
    // The extension set only allows RichTextDoc nodes and marks.
    onUpdate: ({ editor: e }) => onChangeRef.current(e.getJSON() as RichTextDoc),
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-[#2A2A2A] dark:bg-[#111111]">
      {editor ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
    }),
  });

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-1.5 py-1 dark:border-[#2A2A2A]">
      <ToolButton label="Bold" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Heading" active={state.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Subheading" active={state.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Bulleted list" active={state.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <ToolButton label="Numbered list" active={state.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-3.5 w-3.5" aria-hidden />
      </ToolButton>
      <select
        aria-label="Insert placeholder"
        className={cn(selectCls, 'ml-auto w-auto py-1 text-[12px]')}
        value=""
        onChange={(e) => {
          const key = e.target.value;
          if (key) editor.chain().focus().insertContent({ type: 'placeholder', attrs: { key } }).run();
        }}
      >
        <option value="">Insert placeholder…</option>
        {PLACEHOLDERS.map((p) => (
          <option key={p} value={p}>{`{{${p}}}`}</option>
        ))}
      </select>
    </div>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'rounded p-1.5 text-slate-600 transition hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#1A1A1A]',
        active && 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300',
      )}
    >
      {children}
    </button>
  );
}
