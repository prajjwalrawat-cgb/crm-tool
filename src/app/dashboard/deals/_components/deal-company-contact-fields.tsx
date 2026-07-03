'use client';

import { useState } from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactPickerOption } from '@/lib/contacts/queries';
import { cn } from '@/lib/utils';

/**
 * Linked Company + Contact dropdowns for the deal form. Company selection
 * drives the Contact list (only contacts of the chosen company show).
 *
 * The special "Other" company option represents an INDIVIDUAL customer with no
 * company: picking it submits no company and lets you choose a company-less
 * contact. Because "Other" is a UI sentinel (not a real id), the visible
 * company <select> is uncontrolled-by-name and a hidden `companyId` input
 * carries the real value ('' for both "Select" and "Other").
 */
const selectCls =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

const OTHER = '__other__';

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
  // A deal with no company but a contact is an individual customer → open on
  // "Other" so the contact shows.
  const [companySel, setCompanySel] = useState<string>(
    defaultCompanyId ?? (defaultContactId ? OTHER : ''),
  );
  const [contactId, setContactId] = useState(defaultContactId ?? '');

  const isOther = companySel === OTHER;
  const contactsForCompany = isOther
    ? contactOptions.filter((c) => c.companyId == null)
    : companySel
      ? contactOptions.filter((c) => c.companyId === companySel)
      : [];
  const contactEnabled = companySel !== '';

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="companySel" className="text-xs font-medium text-slate-700">
          Company
        </label>
        {/* Hidden field carries the real companyId; "Other" and "" both = none. */}
        <input type="hidden" name="companyId" value={isOther ? '' : companySel} />
        <select
          id="companySel"
          value={companySel}
          onChange={(e) => {
            setCompanySel(e.target.value);
            setContactId('');
          }}
          className={cn(selectCls, companyError?.length && 'border-red-300')}
        >
          <option value="">— Select company —</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value={OTHER}>Other (individual / no company)</option>
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
          disabled={!contactEnabled}
          className={cn(
            selectCls,
            !contactEnabled && 'cursor-not-allowed bg-slate-50 text-slate-400',
            contactError?.length && 'border-red-300',
          )}
        >
          <option value="">
            {!contactEnabled
              ? 'Select a company first'
              : isOther
                ? contactsForCompany.length
                  ? '— Select individual —'
                  : 'No contacts without a company'
                : contactsForCompany.length
                  ? '— Select contact —'
                  : 'No contacts for this company'}
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
