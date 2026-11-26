import type { MeetingStatus } from '@/db/schema/enums';
import { FieldError } from './types';

export const MEETING_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  planned: ['en_route', 'arrived', 'checked_in', 'cancelled', 'mom_logged'],
  en_route: ['planned', 'arrived', 'checked_in', 'cancelled'],
  arrived: ['checked_in', 'cancelled'],
  checked_in: ['checked_out'],
  checked_out: ['mom_logged'],
  mom_logged: [],
  cancelled: [],
};

export function assertTransition(from: MeetingStatus, to: MeetingStatus, type: 'physical' | 'virtual'): void {
  const allowed = MEETING_TRANSITIONS[from].includes(to);
  // planned -> mom_logged is only for virtual meetings (no check-in to make).
  const virtualOnlyBlocked = from === 'planned' && to === 'mom_logged' && type !== 'virtual';
  if (!allowed || virtualOnlyBlocked) {
    throw new FieldError('invalid_transition', `Cannot move a ${type} meeting from ${from} to ${to}`, { from, to, type });
  }
}
