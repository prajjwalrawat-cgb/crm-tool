import 'server-only';

import { sql } from 'drizzle-orm';

import { prospectStageHistory } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';

import { getProspectSettingsTx } from './settings';

const DAY_MS = 86_400_000;

/**
 * Daily prospect upkeep for one tenant: park stale prospects and release expired
 * claims, each respecting its enabled flag. Safe to re-run (a second pass finds
 * nothing new). `now` is injectable for tests.
 */
export async function runProspectMaintenance(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ parked: number; released: number }> {
  const nowIso = now.toISOString();
  return runWithSystemContext(tenantId, async () => {
    const out = await tenantTransaction(async (tx) => {
      const settings = await getProspectSettingsTx(tx, tenantId);

      let parked = 0;
      if (settings.autoParkEnabled) {
        const cutoffIso = new Date(now.getTime() - settings.autoParkDays * DAY_MS).toISOString();
        // One statement. The candidate rows are locked and the stale condition is
        // re-checked in the UPDATE's WHERE, so a prospect touched after selection
        // (activity bump, promote, delete, manual park) is skipped. It does not bump
        // last_activity_at: parking is not activity.
        const rows = (await tx.execute(sql`
          WITH old AS (
            SELECT id, stage FROM prospects
            WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND promoted_deal_id IS NULL
              AND stage <> 'parked' AND last_activity_at < ${cutoffIso}::timestamptz
            FOR UPDATE
          )
          UPDATE prospects p
          SET stage = 'parked', parked_reason = 'stale', stage_changed_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
          FROM old
          WHERE p.id = old.id AND p.tenant_id = ${tenantId} AND p.deleted_at IS NULL
            AND p.promoted_deal_id IS NULL AND p.stage <> 'parked' AND p.last_activity_at < ${cutoffIso}::timestamptz
          RETURNING p.id AS id, old.stage AS from_stage
        `)) as unknown as Array<{ id: string; from_stage: (typeof prospectStageHistory.$inferInsert)['fromStage'] }>;
        if (rows.length > 0) {
          await tx.insert(prospectStageHistory).values(
            rows.map((r) => ({
              tenantId,
              prospectId: r.id,
              fromStage: r.from_stage,
              toStage: 'parked' as const,
              changedBy: 'system:auto-park',
              changedAt: now,
            })),
          );
        }
        parked = rows.length;
      }

      let expired: Array<{ id: string; claimed_by: string; company_name: string }> = [];
      if (settings.claimExpiryEnabled) {
        // RETURNING sees the new row, so the former claimer comes from the locked snapshot.
        expired = (await tx.execute(sql`
          WITH old AS (
            SELECT id, claimed_by FROM prospects
            WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
              AND claimed_by IS NOT NULL AND claim_expires_at <= ${nowIso}::timestamptz
            FOR UPDATE
          )
          UPDATE prospects p
          SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ${nowIso}::timestamptz
          FROM old
          WHERE p.id = old.id AND p.tenant_id = ${tenantId} AND p.deleted_at IS NULL
            AND p.claimed_by IS NOT NULL AND p.claim_expires_at <= ${nowIso}::timestamptz
          RETURNING p.id AS id, old.claimed_by AS claimed_by, p.company_name AS company_name
        `)) as unknown as typeof expired;
      }
      return { parked, expired };
    });

    // After commit and best-effort: a failed notification never undoes a release.
    for (const e of out.expired) {
      await recordNotificationsSafe(
        {
          tenantId,
          actorUserId: null,
          type: 'prospect_claim_expired',
          title: `Your claim on ${e.company_name} expired`,
          entityType: 'prospect',
          entityId: e.id,
        },
        [e.claimed_by],
      );
    }
    return { parked: out.parked, released: out.expired.length };
  });
}
