'use client';

import { Archive, Copy, Pencil, Star } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import {
  archiveQuoteTemplateAction,
  duplicateQuoteTemplateAction,
  setDefaultQuoteTemplateAction,
} from '@/lib/quotes/actions';

import { Badge, Button, Card, EmptyState, formatWhen } from '../../lead-capture/_components/ui';

export type TemplateListItem = {
  id: string;
  name: string;
  isDefault: boolean;
  /** ISO timestamp. */
  updatedAt: string;
};

export function TemplateList({ templates }: { templates: TemplateListItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, okMsg: string) {
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(okMsg);
      router.refresh();
    });
  }

  if (templates.length === 0) {
    return <EmptyState title="No templates">Reload the page to create the starter template.</EmptyState>;
  }

  return (
    <Card>
      <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
        {templates.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  href={`/dashboard/settings/quote-templates/${t.id}`}
                  className="truncate text-[13.5px] font-medium text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                >
                  {t.name}
                </Link>
                {t.isDefault ? <Badge tone="active">Default</Badge> : null}
              </div>
              <div className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">Last updated {formatWhen(t.updatedAt)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => duplicateQuoteTemplateAction(t.id), `Duplicated “${t.name}”`)}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> Duplicate
              </Button>
              {!t.isDefault ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => setDefaultQuoteTemplateAction(t.id), `“${t.name}” is now the default`)}
                >
                  <Star className="h-3.5 w-3.5" aria-hidden /> Set default
                </Button>
              ) : null}
              {!t.isDefault ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Archive “${t.name}”? New quotes can no longer use it; existing quotes are unchanged.`)) return;
                    run(() => archiveQuoteTemplateAction(t.id), `Archived “${t.name}”`);
                  }}
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
                </Button>
              ) : null}
              <Link
                href={`/dashboard/settings/quote-templates/${t.id}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7] dark:hover:bg-[#181818]"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
