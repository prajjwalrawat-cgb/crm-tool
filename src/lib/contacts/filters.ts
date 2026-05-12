/**
 * Client- and server-safe filter shape for the Contacts page.
 *
 * URL contract:
 *   companyId=<uuid>       restrict to a single company
 *   noCompany=1            unattached contacts only
 *   recentActivityDays=14  any activity in the last N days
 *   createdWithinDays=30   created in the last N days
 */

export type ContactFilters = {
  companyId?: string;
  noCompany?: boolean;
  recentActivityDays?: number;
  createdWithinDays?: number;
  mine?: boolean;
  unassigned?: boolean;
};

const flag = (v: string | string[] | undefined): boolean =>
  v === '1' || v === 'true';
const numVal = (
  v: string | string[] | undefined,
): number | undefined => {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function parseContactFilters(
  raw: Partial<Record<string, string | string[] | undefined>>,
): ContactFilters {
  return {
    companyId:
      typeof raw.companyId === 'string' && raw.companyId.length > 0
        ? raw.companyId
        : undefined,
    noCompany: flag(raw.noCompany),
    recentActivityDays: numVal(raw.recentActivityDays),
    createdWithinDays: numVal(raw.createdWithinDays),
    mine: flag(raw.mine),
    unassigned: flag(raw.unassigned),
  };
}

export function contactFiltersToSearchParams(
  filters: ContactFilters,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.companyId) out.set('companyId', filters.companyId);
  if (filters.noCompany) out.set('noCompany', '1');
  if (filters.recentActivityDays) {
    out.set('recentActivityDays', String(filters.recentActivityDays));
  }
  if (filters.createdWithinDays) {
    out.set('createdWithinDays', String(filters.createdWithinDays));
  }
  if (filters.mine) out.set('mine', '1');
  if (filters.unassigned) out.set('unassigned', '1');
  return out;
}

export function hasActiveContactFilters(filters: ContactFilters): boolean {
  return Boolean(
    filters.companyId ||
      filters.noCompany ||
      filters.recentActivityDays ||
      filters.createdWithinDays ||
      filters.mine ||
      filters.unassigned,
  );
}
