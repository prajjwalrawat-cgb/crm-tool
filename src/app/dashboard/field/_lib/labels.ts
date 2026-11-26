import type { MeetingStatus } from '@/db/schema/enums';
import type { RiskReason } from '@/lib/field/types';

/** Rep-facing labels and chip colours for meeting status and risk reasons. */

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  planned: 'Planned',
  en_route: 'On the way',
  arrived: 'Arrived',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  mom_logged: 'Done',
  cancelled: 'Cancelled',
};

export const STATUS_TONE: Record<MeetingStatus, string> = {
  planned: 'bg-slate-100 text-slate-700 dark:bg-[#1F1F1F] dark:text-[#D4D4D8]',
  en_route: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  arrived: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  checked_in: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  checked_out: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300',
  mom_logged: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-500 line-through dark:bg-[#1F1F1F] dark:text-[#71717A]',
};

export function riskLabel(reason: RiskReason, risk: { travelGapMin: number | null; estDriveMin: number | null }): string {
  switch (reason) {
    case 'no_checkin':
      return 'Not checked in';
    case 'overlap':
      return 'Overlaps another meeting';
    case 'travel_gap':
      return risk.estDriveMin !== null && risk.travelGapMin !== null
        ? `Tight travel: ~${risk.estDriveMin} min drive, ${risk.travelGapMin} min gap`
        : 'Tight travel time';
    case 'mom_missing':
      return 'MOM overdue';
  }
}
