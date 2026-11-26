import type { MeetingStatus } from '@/db/schema/enums';

import { zonedInputToIso } from './datetime';

/**
 * Pure helpers for editing and cancelling a meeting from the field pages. They
 * mirror the service gates in src/lib/field/meetings.ts (buildUpdate) and the
 * state machine (cancel only from planned / en_route / arrived); the server
 * stays the authority and its errors are shown as-is.
 */

/** Type, owner, times, address and meeting link may change only before the visit. */
const PRE_VISIT = new Set<MeetingStatus>(['planned', 'en_route']);
const CANCELLABLE = new Set<MeetingStatus>(['planned', 'en_route', 'arrived']);

export type EditGates = {
  /** type, owner, date and times, address, meeting link */
  structural: boolean;
  /** title and deal / company / contact links */
  details: boolean;
  notes: boolean;
};

export function editGates(status: MeetingStatus): EditGates {
  if (status === 'cancelled') return { structural: false, details: false, notes: false };
  return {
    structural: PRE_VISIT.has(status),
    details: status !== 'mom_logged',
    notes: true,
  };
}

export const canEditMeeting = (status: MeetingStatus): boolean => status !== 'cancelled';
/** Cancel only before check-in. */
export const canCancelMeeting = (status: MeetingStatus): boolean => CANCELLABLE.has(status);

export type MeetingFormValues = {
  title: string;
  type: 'physical' | 'virtual';
  /** Tenant-local 'YYYY-MM-DD', 'HH:mm', 'HH:mm'. */
  date: string;
  startTime: string;
  endTime: string;
  ownerId: string;
  dealId: string | null;
  companyId: string | null;
  contactId: string | null;
  address: string;
  virtualUrl: string;
  notes: string;
};

const norm = (v: string) => v.trim() || null;

/**
 * The PATCH body for an edit: only fields that changed and that the gates allow.
 * Throws an Error with user-facing copy for invalid times.
 */
export function meetingPatch(
  initial: MeetingFormValues,
  next: MeetingFormValues,
  tz: string,
  gates: EditGates,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (gates.details && next.title.trim() !== initial.title.trim()) body.title = next.title.trim();
  if (gates.details) {
    for (const k of ['dealId', 'companyId', 'contactId'] as const) {
      if (next[k] !== initial[k]) body[k] = next[k];
    }
  }
  if (gates.notes && norm(next.notes) !== norm(initial.notes)) body.notes = norm(next.notes);
  if (gates.structural) {
    if (next.type !== initial.type) body.type = next.type;
    if (next.ownerId !== initial.ownerId) body.ownerId = next.ownerId;
    if (next.date !== initial.date || next.startTime !== initial.startTime || next.endTime !== initial.endTime) {
      const startAt = zonedInputToIso(`${next.date}T${next.startTime}`, tz);
      const endAt = zonedInputToIso(`${next.date}T${next.endTime}`, tz);
      if (!startAt || !endAt) throw new Error('Pick a date, start and end time.');
      if (new Date(endAt).getTime() <= new Date(startAt).getTime()) throw new Error('End time must be after the start.');
      body.startAt = startAt;
      body.endAt = endAt;
    }
    if (next.type === 'physical' && norm(next.address) !== norm(initial.address)) body.address = norm(next.address);
    if (next.type === 'virtual' && norm(next.virtualUrl) !== norm(initial.virtualUrl)) body.virtualUrl = norm(next.virtualUrl);
  }
  return body;
}

/** Server error copy for an edit or cancel; a 409 means the meeting moved on meanwhile. */
export function editErrorText(res: { error: string; code?: string }): string {
  if (res.code === 'invalid_transition') return `${res.error}. It may have changed since you opened it: refresh and try again.`;
  return res.error;
}
