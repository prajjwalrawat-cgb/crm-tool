import { type DealStage } from './schema';

/**
 * Per-stage win probability used to weight pipeline value
 * (weighted = Σ amount × stage probability). Defaults follow a standard
 * B2B pipeline; workspaces can override per stage in Settings → Pipeline
 * (persisted on organization_settings.stage_probabilities).
 *
 * won = 100 (closed), lost = 0 by definition; those aren't user-editable.
 */
export const DEFAULT_STAGE_PROBABILITY: Record<DealStage, number> = {
  lead: 10,
  qualified: 30,
  proposal: 60,
  negotiation: 80,
  hold: 40,
  won: 100,
  lost: 0,
};

export type StageProbabilities = Record<DealStage, number>;

/** Stages whose probability the user can configure (won/lost are fixed). */
export const CONFIGURABLE_PROBABILITY_STAGES: DealStage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'hold',
];

/**
 * Merge stored overrides over the defaults, ignoring anything out of the
 * 0–100 range or non-numeric. won/lost always keep their fixed values.
 */
export function resolveStageProbabilities(
  overrides: Partial<Record<string, unknown>> | null | undefined,
): StageProbabilities {
  const out: StageProbabilities = { ...DEFAULT_STAGE_PROBABILITY };
  if (overrides) {
    for (const stage of CONFIGURABLE_PROBABILITY_STAGES) {
      const v = overrides[stage];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) {
        out[stage] = v;
      }
    }
  }
  return out;
}
