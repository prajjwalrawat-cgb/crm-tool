import { sql, type SQL } from 'drizzle-orm';

/**
 * Reusable SQL fragments for working with polymorphic id columns.
 *
 * The motivating bug: `activity_logs.entity_id` is a `text` column that
 * stores a MIX of value shapes:
 *   - UUIDs       for company / contact / deal / task / note / email rows
 *   - `user_…`    for membership rows (Clerk user ids)
 *   - `orginv_…`  for invitation rows (Clerk invitation ids)
 *
 * A bare `entity_id::uuid` cast crashes the page when any row in the
 * scanned set isn't UUID-shaped. The cast is unsafe even when the WHERE
 * clause restricts `entity_type` because the planner can reorder steps
 * and because legacy / future entity types may slip in.
 *
 * Use these helpers anywhere you cast a text id column to UUID for a
 * join or aggregate.
 */

/** Postgres regex matching a canonical 36-char UUID. */
const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Returns an SQL fragment that yields the column as `uuid` when it
 * matches the UUID shape, NULL otherwise. Combine with `IS NOT NULL`
 * (or a join's natural drop of NULL keys) to filter out non-UUID rows.
 *
 * Usage:
 *   SELECT ${safeUuidCast('al.entity_id')} AS deal_id FROM activity_logs al
 *   WHERE al.entity_id ~ ${UUID_REGEX}
 *
 * Or shorter — the helper below pairs the cast with its filter.
 */
export function safeUuidCast(columnSql: string): SQL {
  return sql.raw(
    `CASE WHEN ${columnSql} ~ '${UUID_REGEX}' THEN ${columnSql}::uuid END`,
  );
}

/**
 * Returns a WHERE-clause-friendly fragment: `<col> ~ '<uuid-regex>'`.
 * Add it as an AND-condition to scans that will later cast the column.
 *
 * Usage:
 *   WHERE tenant_id = ${id}::uuid
 *     AND entity_type = 'deal'
 *     AND ${isUuidShaped('entity_id')}
 */
export function isUuidShaped(columnSql: string): SQL {
  return sql.raw(`${columnSql} ~ '${UUID_REGEX}'`);
}

/** Raw regex literal, exposed for callers writing larger composite filters. */
export const UUID_REGEX_LITERAL = UUID_REGEX;
