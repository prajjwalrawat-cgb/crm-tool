import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { companies, contacts, mergeAudit } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import {
  runWithTenantContext,
  tenantTransaction,
  type DbExecutor,
} from '@/lib/db-context';

import {
  normalizeCompanyName,
  normalizeContactName,
  normalizeEmail,
} from './normalize';

/** Similarity threshold for a "possible duplicate" (spec: ≥ 0.55). */
const SIM_THRESHOLD = 0.55;

export type DedupMatch = {
  id: string;
  label: string;
  sublabel: string | null;
  similarity: number;
  /** exact = same normalized name; fuzzy = trigram-similar. */
  kind: 'exact' | 'fuzzy';
};

/* ============================================================ */
/* Creation-time matching                                        */
/* ============================================================ */

/**
 * Similar existing companies for a typed name — exact-normalized OR trigram
 * (similarity / word_similarity ≥ 0.55). Excludes soft-deleted + merged rows.
 */
export async function findCompanyMatches(
  tenantId: string,
  name: string,
  limit = 5,
): Promise<DedupMatch[]> {
  const norm = normalizeCompanyName(name);
  if (norm.length < 2) return [];

  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT id, name, domain,
        (normalized_name = ${norm}) AS exact,
        greatest(
          similarity(normalized_name, ${norm}),
          word_similarity(${norm}, normalized_name)
        )::float8 AS score
      FROM companies
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL AND merged_into_id IS NULL
        AND normalized_name IS NOT NULL AND normalized_name <> ''
        AND (
          normalized_name = ${norm}
          OR similarity(normalized_name, ${norm}) >= ${SIM_THRESHOLD}
          OR word_similarity(${norm}, normalized_name) >= ${SIM_THRESHOLD}
        )
      ORDER BY exact DESC, score DESC
      LIMIT ${limit}
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    domain: string | null;
    exact: boolean;
    score: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    label: r.name,
    sublabel: r.domain,
    similarity: Number(r.score),
    kind: r.exact ? 'exact' : 'fuzzy',
  }));
}

/** An existing, active contact with this exact email (case-insensitive), or null. */
export async function findContactByEmail(
  tenantId: string,
  email: string,
): Promise<{ id: string; name: string } | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          sql`lower(${contacts.email}) = ${norm}`,
          isNull(contacts.deletedAt),
          isNull(contacts.mergedIntoId),
        ),
      )
      .limit(1),
  );
  if (!row) return null;
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
  return { id: row.id, name: name || norm };
}

/** Fuzzy name matches for a contact being created (warning, not blocking). */
export async function findContactNameMatches(
  tenantId: string,
  firstName: string | null,
  lastName: string | null,
  limit = 5,
): Promise<DedupMatch[]> {
  const norm = normalizeContactName(firstName, lastName);
  if (norm.length < 3) return [];
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT id, first_name, last_name, email,
        similarity(normalized_name, ${norm})::float8 AS score
      FROM contacts
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL AND merged_into_id IS NULL
        AND normalized_name IS NOT NULL AND normalized_name <> ''
        AND similarity(normalized_name, ${norm}) >= ${SIM_THRESHOLD}
      ORDER BY score DESC
      LIMIT ${limit}
    `),
  )) as unknown as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    score: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    label: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || '(no name)',
    sublabel: r.email,
    similarity: Number(r.score),
    kind: 'fuzzy' as const,
  }));
}

/* ============================================================ */
/* Existing-debt audit (Data Quality page)                       */
/* ============================================================ */

export type DuplicatePair = {
  a: { id: string; label: string; sublabel: string | null };
  b: { id: string; label: string; sublabel: string | null };
  similarity: number;
  reason: 'same_name' | 'same_email' | 'similar_name';
};

export async function findCompanyDuplicatePairs(
  tenantId: string,
  limit = 100,
): Promise<DuplicatePair[]> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT a.id a_id, a.name a_name, a.domain a_domain,
             b.id b_id, b.name b_name, b.domain b_domain,
             (a.normalized_name = b.normalized_name) AS same_name,
             greatest(similarity(a.normalized_name, b.normalized_name),
                      word_similarity(a.normalized_name, b.normalized_name))::float8 AS score
      FROM companies a
      JOIN companies b
        ON a.tenant_id = b.tenant_id AND a.id < b.id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.deleted_at IS NULL AND a.merged_into_id IS NULL
        AND b.deleted_at IS NULL AND b.merged_into_id IS NULL
        AND a.normalized_name <> '' AND b.normalized_name <> ''
        AND (a.normalized_name = b.normalized_name
             OR similarity(a.normalized_name, b.normalized_name) >= ${SIM_THRESHOLD})
      ORDER BY score DESC
      LIMIT ${limit}
    `),
  )) as unknown as Array<{
    a_id: string; a_name: string; a_domain: string | null;
    b_id: string; b_name: string; b_domain: string | null;
    same_name: boolean; score: number;
  }>;
  return rows.map((r) => ({
    a: { id: r.a_id, label: r.a_name, sublabel: r.a_domain },
    b: { id: r.b_id, label: r.b_name, sublabel: r.b_domain },
    similarity: Number(r.score),
    reason: r.same_name ? 'same_name' : 'similar_name',
  }));
}

export async function findContactDuplicatePairs(
  tenantId: string,
  limit = 100,
): Promise<DuplicatePair[]> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT a.id a_id, a.first_name a_fn, a.last_name a_ln, a.email a_email,
             b.id b_id, b.first_name b_fn, b.last_name b_ln, b.email b_email,
             (a.email IS NOT NULL AND lower(a.email) = lower(b.email)) AS same_email,
             CASE WHEN a.normalized_name <> '' AND b.normalized_name <> ''
               THEN similarity(a.normalized_name, b.normalized_name) ELSE 0 END::float8 AS score
      FROM contacts a
      JOIN contacts b
        ON a.tenant_id = b.tenant_id AND a.id < b.id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.deleted_at IS NULL AND a.merged_into_id IS NULL
        AND b.deleted_at IS NULL AND b.merged_into_id IS NULL
        AND (
          (a.email IS NOT NULL AND lower(a.email) = lower(b.email))
          OR (a.normalized_name <> '' AND b.normalized_name <> ''
              AND similarity(a.normalized_name, b.normalized_name) >= ${SIM_THRESHOLD})
        )
      ORDER BY same_email DESC, score DESC
      LIMIT ${limit}
    `),
  )) as unknown as Array<{
    a_id: string; a_fn: string | null; a_ln: string | null; a_email: string | null;
    b_id: string; b_fn: string | null; b_ln: string | null; b_email: string | null;
    same_email: boolean; score: number;
  }>;
  const nm = (fn: string | null, ln: string | null) =>
    [fn, ln].filter(Boolean).join(' ').trim() || '(no name)';
  return rows.map((r) => ({
    a: { id: r.a_id, label: nm(r.a_fn, r.a_ln), sublabel: r.a_email },
    b: { id: r.b_id, label: nm(r.b_fn, r.b_ln), sublabel: r.b_email },
    similarity: r.same_email ? 1 : Number(r.score),
    reason: r.same_email ? 'same_email' : 'similar_name',
  }));
}

/* ============================================================ */
/* Merge                                                         */
/* ============================================================ */

// Polymorphic (entity_type, entity_id) tables whose entity_id is UUID.
const POLY_UUID_TABLES = [
  'notes',
  'comments',
  'tasks',
  'notifications',
  'email_messages',
  'email_drafts',
  'communication_threads',
  'communication_drafts',
];
// … whose entity_id is TEXT (stores uuid-as-text for company/contact).
const POLY_TEXT_TABLES = [
  'activity_logs',
  'agent_observations',
  'agent_recommendation_feedback',
];
// Derived/regenerable rows we DELETE from the loser (avoids unique conflicts;
// the winner regenerates them). uuid entity_id.
const DERIVED_UUID_TABLES = ['relationship_signals'];
// … text entity_id.
const DERIVED_TEXT_TABLES = ['embeddings', 'ai_summaries'];

async function execCount(exec: DbExecutor, query: ReturnType<typeof sql>): Promise<number> {
  const r = (await exec.execute(query)) as unknown as { count?: number };
  return r?.count ?? 0;
}

export type MergeResult =
  | { ok: true; auditId: string; repointed: Record<string, number> }
  | { ok: false; message: string };

/**
 * Merge `loserId` into `winnerId` for companies or contacts. Repoints every
 * child record, deletes regenerable derived rows on the loser, soft-deletes the
 * loser (merged_into_id + deleted_at), and writes a merge_audit row holding the
 * full loser snapshot for reversibility. Never auto-called — one human click.
 */
export async function mergeRecords(
  entityType: 'company' | 'contact',
  tenantId: string,
  winnerId: string,
  loserId: string,
  userId: string,
): Promise<MergeResult> {
  if (winnerId === loserId) {
    return { ok: false, message: 'Cannot merge a record into itself.' };
  }

  // includeDeleted: PG enforces the SELECT USING policy as a WITH CHECK on the
  // loser soft-delete's new row (deleted_at set), so we need the include-deleted
  // context — same reason the soft-delete actions use it.
  return runWithTenantContext(
    { tenantId, userId, includeDeleted: true },
    () =>
      tenantTransaction(async (tx) => {
    const table = entityType === 'company' ? companies : contacts;
    const [winner] = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.id, winnerId),
          eq(table.tenantId, tenantId),
          isNull(table.deletedAt),
          isNull(table.mergedIntoId),
        ),
      )
      .limit(1);
    const [loser] = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, loserId),
          eq(table.tenantId, tenantId),
          isNull(table.deletedAt),
          isNull(table.mergedIntoId),
        ),
      )
      .limit(1);
    if (!winner || !loser) {
      return { ok: false, message: 'Both records must exist and be active.' };
    }

    const repointed: Record<string, number> = {};

    // Hard FK repointing.
    if (entityType === 'company') {
      repointed.contacts = await execCount(tx, sql`
        UPDATE contacts SET company_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND company_id = ${loserId}::uuid`);
      repointed.deals = await execCount(tx, sql`
        UPDATE deals SET company_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND company_id = ${loserId}::uuid`);
    } else {
      repointed.deals = await execCount(tx, sql`
        UPDATE deals SET contact_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${loserId}::uuid`);
      // deal_contacts has a unique (deal_id, contact_id) — drop conflicting loser
      // rows first, then repoint the rest.
      await tx.execute(sql`
        DELETE FROM deal_contacts
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${loserId}::uuid
          AND deal_id IN (
            SELECT deal_id FROM deal_contacts
            WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${winnerId}::uuid)`);
      repointed.deal_contacts = await execCount(tx, sql`
        UPDATE deal_contacts SET contact_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${loserId}::uuid`);
      repointed.communication_participants = await execCount(tx, sql`
        UPDATE communication_participants SET contact_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${loserId}::uuid`);
    }

    // Polymorphic repointing.
    for (const t of POLY_UUID_TABLES) {
      repointed[t] = await execCount(tx, sql`
        UPDATE ${sql.raw(`"${t}"`)} SET entity_id = ${winnerId}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND entity_type = ${entityType}
          AND entity_id = ${loserId}::uuid`);
    }
    for (const t of POLY_TEXT_TABLES) {
      repointed[t] = await execCount(tx, sql`
        UPDATE ${sql.raw(`"${t}"`)} SET entity_id = ${winnerId}
        WHERE tenant_id = ${tenantId}::uuid AND entity_type = ${entityType}
          AND entity_id = ${loserId}`);
    }
    // Delete regenerable derived rows on the loser.
    for (const t of DERIVED_UUID_TABLES) {
      await tx.execute(sql`
        DELETE FROM ${sql.raw(`"${t}"`)}
        WHERE tenant_id = ${tenantId}::uuid AND entity_type = ${entityType}
          AND entity_id = ${loserId}::uuid`);
    }
    for (const t of DERIVED_TEXT_TABLES) {
      await tx.execute(sql`
        DELETE FROM ${sql.raw(`"${t}"`)}
        WHERE tenant_id = ${tenantId}::uuid AND entity_type = ${entityType}
          AND entity_id = ${loserId}`);
    }

    // Soft-delete the loser: merged_into_id + deleted_at.
    await tx
      .update(table)
      .set({ mergedIntoId: winnerId, deletedAt: new Date(), deletedBy: userId })
      .where(and(eq(table.id, loserId), eq(table.tenantId, tenantId)));

    // Audit row (full loser snapshot for reversibility).
    const [audit] = await tx
      .insert(mergeAudit)
      .values({
        tenantId,
        entityType,
        winnerId,
        loserId,
        loserSnapshot: loser as unknown as Record<string, unknown>,
        repointedCounts: repointed,
        mergedBy: userId,
      })
      .returning({ id: mergeAudit.id });

        await recordActivity(tx, {
          tenantId,
          actorUserId: userId,
          entityType,
          entityId: winnerId,
          action: 'merged',
          metadata: { loserId, auditId: audit!.id, repointed },
        });

        return { ok: true, auditId: audit!.id, repointed };
      }),
  );
}
