/**
 * The plan-term catalogue: one entry per field, shared by the admin form,
 * the version diff, the bulk-change picker and the DB mapping. Adding a term
 * means adding it here and to `IncentivePlanTerms` — the form, the audit
 * trail and the bulk tool then pick it up without further edits.
 *
 * Pure + client-safe.
 */
import {
  ACCRUAL_BASES,
  MARGIN_MISS_TREATMENTS,
  type AccrualBasis,
  type IncentivePlanTerms,
  type MarginMissTreatment,
} from './engine';
import { Rational } from './rational';

export type TermKey = keyof IncentivePlanTerms;

export type TermField =
  | { key: TermKey; label: string; kind: 'number'; unit: '₹ L' | '₹ Cr' | 'fraction'; hint?: string; bulk: boolean }
  | { key: TermKey; label: string; kind: 'enum'; options: readonly { value: string; label: string }[]; hint?: string; bulk: boolean }
  | { key: TermKey; label: string; kind: 'boolean'; hint?: string; bulk: boolean };

export const ACCRUAL_BASIS_LABELS: Record<AccrualBasis, string> = {
  pro_rata: 'Pro rata (partial steps accrue)',
  full_step_only: 'Full steps only',
};

export const MARGIN_MISS_LABELS: Record<MarginMissTreatment, string> = {
  pro_rata: 'Pro rata (margin ÷ floor)',
  nil: 'Nil below the floor',
  ignore: 'Not enforced',
};

export const TERM_FIELDS: readonly TermField[] = [
  { key: 'fixedCTC', label: 'Fixed CTC', kind: 'number', unit: '₹ L', bulk: false },
  { key: 'targetVariable', label: 'Target variable', kind: 'number', unit: '₹ L', hint: 'The variable pickup in the offer — 100% of target.', bulk: false },
  { key: 'gateRevenueCr', label: 'Gate revenue', kind: 'number', unit: '₹ Cr', hint: 'Credited revenue below this pays nothing.', bulk: true },
  { key: 'gateIncentiveL', label: 'Gate incentive', kind: 'number', unit: '₹ L', hint: 'Paid in full once the gate is crossed.', bulk: true },
  { key: 'slab1UpperCr', label: 'Slab 1 upper limit', kind: 'number', unit: '₹ Cr', bulk: true },
  { key: 'slab1RateL', label: 'Slab 1 rate (per step)', kind: 'number', unit: '₹ L', bulk: true },
  { key: 'slab2RateL', label: 'Slab 2 rate (per step)', kind: 'number', unit: '₹ L', bulk: true },
  { key: 'stepCr', label: 'Step size', kind: 'number', unit: '₹ Cr', hint: 'The "every 1 Cr" unit.', bulk: true },
  {
    key: 'accrualBasis',
    label: 'Accrual basis',
    kind: 'enum',
    options: ACCRUAL_BASES.map((v) => ({ value: v, label: ACCRUAL_BASIS_LABELS[v] })),
    bulk: true,
  },
  { key: 'capEnabled', label: 'Payout cap', kind: 'boolean', bulk: true },
  { key: 'capAmountL', label: 'Cap amount', kind: 'number', unit: '₹ L', bulk: true },
  { key: 'priorYearCreditPct', label: 'Prior-year credit weight', kind: 'number', unit: 'fraction', hint: 'Credit on revenue from deals closed in an earlier FY (workbook: 25%).', bulk: true },
  { key: 'netNewCreditPct', label: 'Net-new credit weight', kind: 'number', unit: 'fraction', hint: 'Credit on revenue from deals closed this FY (workbook: 100%).', bulk: true },
  { key: 'marginFloorPct', label: 'Margin floor', kind: 'number', unit: 'fraction', hint: 'Blended margin below this triggers the treatment below.', bulk: true },
  {
    key: 'marginMissTreatment',
    label: 'Below the margin floor',
    kind: 'enum',
    options: MARGIN_MISS_TREATMENTS.map((v) => ({ value: v, label: MARGIN_MISS_LABELS[v] })),
    bulk: true,
  },
];

export const TERM_KEYS: readonly TermKey[] = TERM_FIELDS.map((f) => f.key);
export const BULK_TERM_KEYS: readonly TermKey[] = TERM_FIELDS.filter((f) => f.bulk).map((f) => f.key);

export function termLabel(key: TermKey): string {
  return TERM_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/** Plan terms as stored and transported: every numeric field a decimal string. */
export type StoredTerms = {
  fixedCTC: string;
  targetVariable: string;
  gateRevenueCr: string;
  gateIncentiveL: string;
  slab1UpperCr: string;
  slab1RateL: string;
  slab2RateL: string;
  stepCr: string;
  accrualBasis: AccrualBasis;
  capEnabled: boolean;
  capAmountL: string | null;
  priorYearCreditPct: string;
  netNewCreditPct: string;
  marginFloorPct: string;
  marginMissTreatment: MarginMissTreatment;
};

/**
 * Canonical decimal string: "2.00" → "2", "0.250000" → "0.25". Postgres
 * numeric pads to its scale, and a diff that reported 2 → 2.00 as a change
 * would bury real edits in noise.
 */
export function canonicalDecimal(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const s = Rational.parse(v as string | number).toFixed(9);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  } catch {
    return String(v);
  }
}

function canonicalValue(key: TermKey, v: unknown): string | boolean | null {
  const field = TERM_FIELDS.find((f) => f.key === key);
  if (field?.kind === 'number') return canonicalDecimal(v);
  if (field?.kind === 'boolean') return Boolean(v);
  return v == null ? null : String(v);
}

export type TermsDiff = Partial<Record<TermKey, { from: string | boolean | null; to: string | boolean | null }>>;

/** Field-by-field changes between two sets of terms. Empty = no change. */
export function diffTerms(
  before: Partial<Record<TermKey, unknown>>,
  after: Partial<Record<TermKey, unknown>>,
): TermsDiff {
  const out: TermsDiff = {};
  for (const key of TERM_KEYS) {
    const a = canonicalValue(key, before[key]);
    const b = canonicalValue(key, after[key]);
    if (a !== b) out[key] = { from: a, to: b };
  }
  return out;
}

/** Normalise any terms-shaped object to canonical stored strings. */
export function toStoredTerms(t: IncentivePlanTerms | StoredTerms): StoredTerms {
  const d = (v: unknown) => canonicalDecimal(v) ?? '0';
  return {
    fixedCTC: d(t.fixedCTC),
    targetVariable: d(t.targetVariable),
    gateRevenueCr: d(t.gateRevenueCr),
    gateIncentiveL: d(t.gateIncentiveL),
    slab1UpperCr: d(t.slab1UpperCr),
    slab1RateL: d(t.slab1RateL),
    slab2RateL: d(t.slab2RateL),
    stepCr: d(t.stepCr),
    accrualBasis: t.accrualBasis,
    capEnabled: Boolean(t.capEnabled),
    // Kept even while the cap is off, so toggling it back on restores the amount.
    capAmountL: canonicalDecimal(t.capAmountL),
    priorYearCreditPct: d(t.priorYearCreditPct),
    netNewCreditPct: d(t.netNewCreditPct),
    marginFloorPct: d(t.marginFloorPct),
    marginMissTreatment: t.marginMissTreatment,
  };
}
