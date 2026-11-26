import type { MembershipRole } from '@/db/schema/enums';

export type LatLng = { lat: number; lng: number };

export type RiskReason = 'no_checkin' | 'travel_gap' | 'overlap' | 'mom_missing';

export type FieldActor = { tenantId: string; userId: string; role: MembershipRole };

export type FieldErrorCode = 'not_found' | 'forbidden' | 'invalid_transition' | 'validation' | 'outside_radius'
  | 'outside_window';

export class FieldError extends Error {
  readonly code: FieldErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: FieldErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FieldError';
    this.code = code;
    this.details = details;
  }
}
