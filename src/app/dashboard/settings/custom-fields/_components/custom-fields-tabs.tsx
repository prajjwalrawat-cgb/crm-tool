'use client';

import { useState } from 'react';

import type { CustomFieldEntity } from '@/db/schema';
import type { AdminCustomField } from '@/lib/custom-fields/queries';
import { cn } from '@/lib/utils';

import { CustomFieldsManager } from './custom-fields-manager';

const TABS: { entity: CustomFieldEntity; label: string; singular: string }[] = [
  { entity: 'deal', label: 'Deals', singular: 'Deal' },
  { entity: 'company', label: 'Companies', singular: 'Company' },
  { entity: 'contact', label: 'Contacts', singular: 'Contact' },
];

export function CustomFieldsTabs({
  deal,
  company,
  contact,
}: {
  deal: AdminCustomField[];
  company: AdminCustomField[];
  contact: AdminCustomField[];
}) {
  const [active, setActive] = useState<CustomFieldEntity>('deal');
  const byEntity: Record<CustomFieldEntity, AdminCustomField[]> = {
    deal,
    company,
    contact,
  };
  const current = TABS.find((t) => t.entity === active)!;

  return (
    <main className="mx-auto w-full max-w-3xl px-1 py-1">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Custom fields</h1>
      </header>

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const activeCount = byEntity[t.entity].filter((f) => !f.archived).length;
          return (
            <button
              key={t.entity}
              type="button"
              onClick={() => setActive(t.entity)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition',
                active === t.entity
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800',
              )}
            >
              {t.label}
              {activeCount > 0 ? (
                <span className="ml-1 text-[11px] text-slate-400">{activeCount}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <CustomFieldsManager
        key={active}
        entityType={active}
        entityLabel={current.singular}
        initial={byEntity[active]}
      />
    </main>
  );
}
