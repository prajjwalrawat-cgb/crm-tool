'use client';

import { useState } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactPickerOption } from '@/lib/contacts/queries';
import { cn } from '@/lib/utils';

/**
 * Linked Company + Contact dropdowns for the deal form. Company selection
 * drives the Contact list (only contacts of the chosen company show). The
 * native `<select name=...>` submits straight through the form's FormData, so
 * no hidden inputs are needed. Company options are role-scoped server-side.
 */
const selectCls =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

export function DealCompanyContactFields({
  companyOptions,
  contactOptions,
  defaultCompanyId,
  defaultContactId,
  companyError,
  contactError,
}: {
  companyOptions: CompanyOption[];
  contactOptions: ContactPickerOption[];
  defaultCompanyId?: string | null;
  defaultContactId?: string | null;
  companyError?: string[];
  contactError?: string[];
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? '');
  const [contactId, setContactId] = useState(defaultContactId ?? '');
  const contactsForCompany = companyId
    ? contactOptions.filter((c) => c.companyId === companyId)
    : [];

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="companyId" className="text-xs font-medium text-slate-700">
          Company
        </label>
        <select
          id="companyId"
          name="companyId"
          value={companyId}
          onChange={(e) => {
            setCompanyId(e.target.value);
            setContactId('');
          }}
          className={cn(selectCls, companyError?.length && 'border-red-300')}
        >
          <option value="">— Select company —</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {companyError?.length ? (
          <p className="text-xs text-red-600">{companyError.join(' ')}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="contactId" className="text-xs font-medium text-slate-700">
          Contact
        </label>
        <select
          id="contactId"
          name="contactId"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          disabled={!companyId}
          className={cn(
            selectCls,
            !companyId && 'cursor-not-allowed bg-slate-50 text-slate-400',
            contactError?.length && 'border-red-300',
          )}
        >
          <option value="">
            {companyId
              ? contactsForCompany.length
                ? '— Select contact —'
                : 'No contacts for this company'
              : 'Select a company first'}
          </option>
          {contactsForCompany.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        {contactError?.length ? (
          <p className="text-xs text-red-600">{contactError.join(' ')}</p>
        ) : null}
      </div>
    </>
  );
}
