import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * The unified, append-only audit trail over the three deal fields that move
 * money: `stage`, `expected_close_date` and `amount_minor`. One row per
 * changed field per UPDATE, written by the `deal_governance_sync` trigger
 * (migration 0060) — never by the app.
 *
 * That the trigger owns it is the whole point: the guarantee "every mutation
 * is logged" would otherwise be only as good as the list of call sites someone
 * remembered to route through an interceptor, and this codebase has many
 * (two stage actions, the full-form update, the inline patch, bulk
 * approve/reject, CSV import, the Lead-cleanup revert, maintenance scripts).
 *
 * Immutable: an UPDATE is rejected by a trigger, and app_user is granted only
 * SELECT and INSERT. Rows disappear only when the parent deal is hard-deleted.
 *
 * Distinct from its two neighbours, which are read models rather than records:
 * `dealStageHistory` (0045) holds stage occupancy intervals and is mutated on
 * exit; `dealDateChanges` (0058) is the close-date timeline backing
 * `deals.pushCount`.
 */
export const dealAuditLog = pgTable(
  'deal_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /**
     * Actor id, same shape as `deals.updatedBy` — text, no FK, because users
     * live in an external directory for Clerk-backed tenants. NULL when the
     * write reached the DB with no actor GUC set (a maintenance script).
     */
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 'stage' | 'expected_close_date' | 'amount_minor'. */
    fieldName: text('field_name').notNull(),
    /** Stored as text: one column spans an enum, a date and a bigint. */
    oldValue: text('old_value'),
    newValue: text('new_value'),
    /** 'forward_progress' | 'rollback' | 'pushback' | 'edit'. */
    changeType: text('change_type').notNull(),
    /** Set (and required by the trigger) only when changeType = 'rollback'. */
    reasonCode: text('reason_code'),
    reasonNote: text('reason_note'),
  },
  (t) => [index('idx_audit_deal').on(t.tenantId, t.dealId, t.changedAt)],
);

export const dealAuditLogRelations = relations(dealAuditLog, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealAuditLog.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealAuditLog.dealId],
    references: [deals.id],
  }),
}));

export type DealAuditLog = typeof dealAuditLog.$inferSelect;
export type NewDealAuditLog = typeof dealAuditLog.$inferInsert;
