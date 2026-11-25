'use client';

import { Loader2, MapPin, Video } from 'lucide-react';
import { useId, useState } from 'react';

import type { MeetingStatus } from '@/db/schema/enums';
import type { DayMeeting } from '@/lib/field/day';
import { cn } from '@/lib/utils';

import { Button, inputCls } from '../../settings/lead-capture/_components/ui';
import { fieldApi } from '../_lib/api';
import { isoToZonedInput, zonedInputToIso } from '../_lib/datetime';
import { editErrorText, editGates, meetingPatch, type MeetingFormValues } from '../_lib/meeting-edit';
import { useTenantTz } from '../_lib/tz-context';
import { EntitySearchSelect, type EntityChoice } from './entity-search-select';

/** The created meeting as the API returns it (JSON: dates are ISO strings). */
export type SavedMeeting = {
  id: string;
  title: string;
  type: 'physical' | 'virtual';
  ownerId: string;
  startAt: string;
  endAt: string;
  status: MeetingStatus;
};

const fieldCls = cn(inputCls, 'min-h-10 text-[14px] sm:text-[13px]');
const labelCls = 'block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]';

/** Next full hour from now, as tenant-local 'YYYY-MM-DDTHH:mm'. */
function defaultStart(tz: string): string {
  // Floor (now + 1 h) to the hour in tenant time (offsets like +05:30 are not whole hours).
  const local = isoToZonedInput(new Date(Date.now() + 60 * 60_000), tz);
  return `${local.slice(0, 14)}00`;
}

function plusMinutes(local: string, minutes: number, tz: string): string | null {
  const iso = zonedInputToIso(local, tz);
  return iso ? isoToZonedInput(new Date(new Date(iso).getTime() + minutes * 60_000), tz) : null;
}

const choice = (x: { id: string; name: string } | null): EntityChoice | null => (x ? { id: x.id, label: x.name } : null);

/** Form values for an existing meeting, in tenant-local wall clock. */
function valuesOf(m: DayMeeting, tz: string): MeetingFormValues {
  const start = isoToZonedInput(m.startAt, tz);
  return {
    title: m.title,
    type: m.type,
    date: start.slice(0, 10),
    startTime: start.slice(11, 16),
    endTime: isoToZonedInput(m.endAt, tz).slice(11, 16),
    ownerId: m.ownerId,
    dealId: m.deal?.id ?? null,
    companyId: m.company?.id ?? null,
    contactId: m.contact?.id ?? null,
    address: m.address ?? '',
    virtualUrl: m.virtualUrl ?? '',
    notes: m.notes ?? '',
  };
}

/**
 * Meeting form (My day, and the manager's Field day page). Times are entered
 * in the tenant timezone (TenantTzProvider) and sent as ISO with that zone's
 * offset. Owner select only shows when there is someone besides self. A blank
 * address on a physical meeting falls back to the company's address.
 *
 * With `meeting` it edits that meeting instead: fields are prefilled, only
 * changed fields are PATCHed, and fields the meeting's status no longer allows
 * (editGates, mirroring the service) are read-only.
 */
export function MeetingForm({
  defaultOwnerId,
  ownersInScope,
  onSaved,
  meeting,
}: {
  defaultOwnerId: string;
  ownersInScope: Array<{ id: string; name: string }>;
  onSaved: (m: SavedMeeting) => void;
  /** Edit this meeting instead of creating one. */
  meeting?: DayMeeting;
}) {
  const tz = useTenantTz();
  const ids = useId();
  const [initialStart] = useState(() => defaultStart(tz));
  const [initial] = useState<MeetingFormValues | null>(() => (meeting ? valuesOf(meeting, tz) : null));
  const gates = meeting ? editGates(meeting.status) : { structural: true, details: true, notes: true };
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState<'physical' | 'virtual'>(initial?.type ?? 'physical');
  const [date, setDate] = useState(initial?.date ?? initialStart.slice(0, 10));
  const [startTime, setStartTime] = useState(initial?.startTime ?? initialStart.slice(11, 16));
  const [endTime, setEndTime] = useState(
    () => initial?.endTime ?? (plusMinutes(initialStart, 60, tz) ?? initialStart).slice(11, 16),
  );
  const [ownerId, setOwnerId] = useState(initial?.ownerId ?? defaultOwnerId);
  const [deal, setDeal] = useState<EntityChoice | null>(() => choice(meeting?.deal ?? null));
  const [company, setCompany] = useState<EntityChoice | null>(() => choice(meeting?.company ?? null));
  const [contact, setContact] = useState<EntityChoice | null>(() => choice(meeting?.contact ?? null));
  const [address, setAddress] = useState(initial?.address ?? '');
  const [virtualUrl, setVirtualUrl] = useState(initial?.virtualUrl ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockStructural = busy || !gates.structural;
  const lockDetails = busy || !gates.details;

  /** Moving the start keeps the meeting length. */
  function changeStart(next: string) {
    const prevStart = zonedInputToIso(`${date}T${startTime}`, tz);
    const prevEnd = zonedInputToIso(`${date}T${endTime}`, tz);
    setStartTime(next);
    if (!prevStart || !prevEnd || !next) return;
    const length = Math.max(15, Math.round((new Date(prevEnd).getTime() - new Date(prevStart).getTime()) / 60_000));
    const end = plusMinutes(`${date}T${next}`, length, tz);
    if (end && end.slice(0, 10) === date) setEndTime(end.slice(11, 16));
  }

  async function submitEdit(m: DayMeeting, from: MeetingFormValues) {
    const next: MeetingFormValues = {
      title,
      type,
      date,
      startTime,
      endTime,
      ownerId,
      dealId: deal?.id ?? null,
      companyId: company?.id ?? null,
      contactId: contact?.id ?? null,
      address,
      virtualUrl,
      notes,
    };
    let body: Record<string, unknown>;
    try {
      body = meetingPatch(from, next, tz, gates);
    } catch (err) {
      return setError(err instanceof Error ? err.message : 'Check the times.');
    }
    if (Object.keys(body).length === 0) return setError('Nothing changed.');
    setBusy(true);
    const res = await fieldApi<SavedMeeting>(`/meetings/${m.id}`, { method: 'PATCH', body });
    setBusy(false);
    if (!res.ok) return setError(editErrorText(res));
    onSaved(res.data);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError('Add a title.');
    if (meeting && initial) return submitEdit(meeting, initial);
    const startAt = zonedInputToIso(`${date}T${startTime}`, tz);
    const endAt = zonedInputToIso(`${date}T${endTime}`, tz);
    if (!startAt || !endAt) return setError('Pick a date, start and end time.');
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) return setError('End time must be after the start.');
    setBusy(true);
    const res = await fieldApi<SavedMeeting>('/meetings', {
      body: {
        title: title.trim(),
        type,
        startAt,
        endAt,
        ownerId,
        dealId: deal?.id ?? null,
        companyId: company?.id ?? null,
        contactId: contact?.id ?? null,
        address: type === 'physical' ? address.trim() || null : null,
        virtualUrl: type === 'virtual' ? virtualUrl.trim() || null : null,
        notes: notes.trim() || null,
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onSaved(res.data);
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {meeting && !gates.structural ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:bg-[#151515] dark:text-[#A1A1AA]">
          {gates.details
            ? 'The visit has started: type, time, owner and place can no longer change.'
            : 'The MOM is logged: only notes can change.'}
        </p>
      ) : null}
      <div className="space-y-1">
        <label htmlFor={`${ids}-title`} className={labelCls}>
          Title
        </label>
        <input
          id={`${ids}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={300}
          placeholder="e.g. Demo at Acme, Sector 62"
          className={fieldCls}
          disabled={lockDetails}
        />
      </div>

      <fieldset className="space-y-1">
        <legend className={labelCls}>Type</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['physical', 'In person', MapPin],
              ['virtual', 'Virtual', Video],
            ] as const
          ).map(([value, text, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={type === value}
              disabled={lockStructural}
              onClick={() => setType(value)}
              className={cn(
                'flex min-h-10 items-center justify-center gap-2 rounded-lg border text-[13px] font-medium transition',
                type === value
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                  : 'border-slate-200 bg-white text-slate-700 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7]',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden /> {text}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="col-span-2 space-y-1 sm:col-span-1">
          <label htmlFor={`${ids}-date`} className={labelCls}>
            Date
          </label>
          <input
            id={`${ids}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={fieldCls}
            disabled={lockStructural}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-start`} className={labelCls}>
            Start
          </label>
          <input
            id={`${ids}-start`}
            type="time"
            value={startTime}
            onChange={(e) => changeStart(e.target.value)}
            className={fieldCls}
            disabled={lockStructural}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-end`} className={labelCls}>
            End
          </label>
          <input
            id={`${ids}-end`}
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className={fieldCls}
            disabled={lockStructural}
          />
        </div>
      </div>
      <p className="-mt-2 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">Times are in {tz}.</p>

      {ownersInScope.length > 1 ? (
        <div className="space-y-1">
          <label htmlFor={`${ids}-owner`} className={labelCls}>
            Owner
          </label>
          <select
            id={`${ids}-owner`}
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className={fieldCls}
            disabled={lockStructural}
          >
            {ownersInScope.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <EntitySearchSelect kind="deal" label="Deal (optional)" value={deal} onChange={setDeal} disabled={lockDetails} />
      <EntitySearchSelect kind="company" label="Company (optional)" value={company} onChange={setCompany} disabled={lockDetails} />
      <EntitySearchSelect kind="contact" label="Contact (optional)" value={contact} onChange={setContact} disabled={lockDetails} />

      {type === 'physical' ? (
        <div className="space-y-1">
          <label htmlFor={`${ids}-address`} className={labelCls}>
            Address
          </label>
          <textarea
            id={`${ids}-address`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={company ? `Leave blank to use ${company.label}'s address` : 'Street, area, city'}
            className={fieldCls}
            disabled={lockStructural}
          />
        </div>
      ) : (
        <div className="space-y-1">
          <label htmlFor={`${ids}-link`} className={labelCls}>
            Meeting link
          </label>
          <input
            id={`${ids}-link`}
            type="url"
            inputMode="url"
            value={virtualUrl}
            onChange={(e) => setVirtualUrl(e.target.value)}
            placeholder="https://meet.google.com/…"
            className={fieldCls}
            disabled={lockStructural}
          />
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor={`${ids}-notes`} className={labelCls}>
          Notes (optional)
        </label>
        <textarea
          id={`${ids}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={fieldCls}
          disabled={busy}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[12.5px] text-rose-600">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="min-h-11 w-full text-[14px]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {busy ? 'Saving…' : meeting ? 'Save changes' : 'Save meeting'}
      </Button>
    </form>
  );
}
