'use client';

import { Loader2, Mail, Send, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ChangeEvent,
} from 'react';
import { toast } from 'sonner';

import { sendEmailAction } from '@/app/dashboard/email/actions';
import { cn } from '@/lib/utils';

type EntityType = 'deal' | 'company' | 'contact';

type Template = {
  id: string;
  label: string;
  subject: string;
  body: string;
};

/**
 * Compose drawer used from every entity detail page. Keeps form
 * state local; submits to the server action, which owns the
 * idempotent send + activity logging.
 *
 * v1 ships plain text. A rich-text editor (Tiptap is already a
 * dep) is the natural next step but is its own session — the schema
 * stores both text_body and html_body so swapping in is additive.
 */
export function ComposeEmailDrawer({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityLabel,
  defaultRecipients = [],
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  entityType: EntityType;
  entityId: string;
  entityLabel: string;
  defaultRecipients?: string[];
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [toInput, setToInput] = useState(defaultRecipients.join(', '));
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Reset state every time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setSubject('');
    setBody('');
    setToInput(defaultRecipients.join(', '));
    setFieldErrors({});
  }, [open, defaultRecipients]);

  // Esc closes + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onOpenChange]);

  const applyTemplate = useCallback(
    (template: Template) => {
      setSubject((prev) => (prev.trim() ? prev : template.subject));
      setBody((prev) => (prev.trim() ? prev : template.body));
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    setFieldErrors({});
    const recipients = toInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (recipients.length === 0) {
      setFieldErrors({ toRecipients: ['At least one recipient is required'] });
      return;
    }
    if (!subject.trim()) {
      setFieldErrors({ subject: ['Subject is required'] });
      return;
    }
    if (!body.trim()) {
      setFieldErrors({ textBody: ['Email body is required'] });
      return;
    }

    const idempotencyKey = crypto.randomUUID();
    startTransition(async () => {
      const result = await sendEmailAction({
        entityType,
        entityId,
        subject: subject.trim(),
        textBody: body,
        toRecipients: recipients,
        idempotencyKey,
      });
      if (!result.ok) {
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        toast.error(result.message);
        return;
      }
      toast.success(`Email sent to ${recipients[0]}${recipients.length > 1 ? ` and ${recipients.length - 1} more` : ''}`);
      onOpenChange(false);
    });
  }, [toInput, subject, body, entityType, entityId, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50"
      aria-hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-label={`Compose email for ${entityLabel}`}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/50 transition-opacity"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-indigo-500" aria-hidden />
            <div>
              <h2 className="text-[14px] font-semibold tracking-tight text-slate-900">
                Compose email
              </h2>
              <p className="text-[11px] text-slate-500">
                Linked to {entityType}: {entityLabel}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <FormField label="To" errors={fieldErrors.toRecipients}>
            <input
              type="text"
              value={toInput}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setToInput(e.target.value)
              }
              placeholder="recipient@example.com, other@example.com"
              className={cn(
                'w-full rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
                'placeholder:text-slate-400 focus:outline-none focus:ring-2',
                fieldErrors.toRecipients?.length
                  ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
                  : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
              )}
            />
          </FormField>

          <FormField label="Subject" errors={fieldErrors.subject}>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Following up on our last conversation"
              className={cn(
                'w-full rounded-md border bg-white px-3 py-1.5 text-sm shadow-sm transition',
                'placeholder:text-slate-400 focus:outline-none focus:ring-2',
                fieldErrors.subject?.length
                  ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
                  : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
              )}
            />
          </FormField>

          <FormField label="Body" errors={fieldErrors.textBody}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder="Hi,&#10;&#10;Following up after our call last week — wanted to share the next steps.&#10;&#10;Best,"
              className={cn(
                'w-full resize-y rounded-md border bg-white px-3 py-2 text-[13px] leading-relaxed shadow-sm transition',
                'placeholder:text-slate-400 focus:outline-none focus:ring-2',
                fieldErrors.textBody?.length
                  ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
                  : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
              )}
            />
          </FormField>

          <Templates onPick={applyTemplate} />
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3">
          <span className="text-[11px] text-slate-400">
            Press ⌘⏎ to send · Esc to close
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden />
            )}
            {pending ? 'Sending…' : 'Send email'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function FormField({
  label,
  errors,
  children,
}: {
  label: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  const hasError = errors && errors.length > 0;
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
      {hasError ? (
        <p className="text-[11px] text-rose-600">{errors!.join(' ')}</p>
      ) : null}
    </div>
  );
}

/**
 * Lightweight starter template picker. v1 ships fixed templates;
 * a future tenant-scoped template store with edit UI builds on this.
 */
const STARTER_TEMPLATES: Template[] = [
  {
    id: 'follow-up',
    label: 'Follow-up',
    subject: 'Following up',
    body:
      'Hi,\n\nWanted to follow up on our last conversation. Let me know if there are any blockers I can help unstick or if a quick call would be useful.\n\nBest,',
  },
  {
    id: 'intro',
    label: 'Intro',
    subject: 'Introducing ourselves',
    body:
      'Hi,\n\nWe haven’t spoken yet — I wanted to introduce myself and share a quick overview of what we do, in case it’s relevant to your team.\n\nHappy to set up 15 minutes if you’re open to it.\n\nBest,',
  },
  {
    id: 'proposal',
    label: 'Proposal',
    subject: 'Proposal — next steps',
    body:
      'Hi,\n\nAttached is the proposal we discussed. Highlights:\n\n  - Scope and timing\n  - Pricing and terms\n  - Onboarding plan\n\nHappy to walk through it on a call this week.\n\nBest,',
  },
  {
    id: 'kickoff',
    label: 'Kickoff',
    subject: 'Welcome — let’s kick off',
    body:
      'Hi,\n\nGreat to have you on board! Here’s what’s next:\n\n  1. Kickoff call — proposing Tuesday at 10am\n  2. Implementation owner intro\n  3. First check-in two weeks out\n\nLet me know if those times work.\n\nBest,',
  },
  {
    id: 'reminder',
    label: 'Reminder',
    subject: 'Quick reminder',
    body:
      'Hi,\n\nGentle reminder on the item below — happy to chat through anything still open.\n\nThanks,',
  },
];

function Templates({ onPick }: { onPick: (template: Template) => void }) {
  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        Templates
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STARTER_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t)}
            className="inline-flex items-center rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700"
            title={t.subject}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
