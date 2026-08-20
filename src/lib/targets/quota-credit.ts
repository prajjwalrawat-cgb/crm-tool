/**
 * WHICH WON DEALS COUNT TOWARD A QUOTA — one definition, imported by
 * every surface that renders an attainment number.
 *
 * Pure + client-safe: no DB, no `server-only`. The KPI strip needs the
 * label copy on the client, the queries need the predicate on the
 * server, and they must not be able to drift apart.
 *
 * ---------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------
 * Both `targetAchievement` and the dashboard's `quotaAchievement`
 * filtered on `approval_status = 'approved'`. Read against the enum's
 * documented meaning that looks right — but 'approved' is only ever
 * written by the manager-approval workflow, and `'none'` is the
 * DEFAULT for every deal in the table.
 *
 * A won deal therefore carries 'none' unless it happened to pass
 * through that workflow. In the CGB Solutions workspace that was 23 of
 * 24 won deals: ₹31,653,123 of real closed revenue filtered out,
 * rendering "0% · ₹0 of ₹40,000,000" three inches from a Pipeline by
 * Stage table reading ₹31,794,123 won across 24 deals.
 *
 * ---------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------
 *   approved → counts. A manager signed off.
 *   none     → counts. No approval was ever REQUIRED of this deal
 *              (closed by a manager/admin, or closed before the gate
 *              existed). Absence of a review is not a failed review.
 *   pending  → withheld. A human is actively being asked to confirm
 *              this revenue. Counting it would pre-empt the answer.
 *   rejected → withheld. A manager said no. (Rejection also reopens
 *              the deal to Negotiation, so a won+rejected row is an
 *              inconsistent state; excluded either way.)
 *
 * Withheld revenue is NOT silently dropped. Every caller returns it
 * alongside the credited figure so the UI can state the gap out loud —
 * see `pendingApprovalNote`. That is what keeps attainment reconcilable
 * with the won total shown elsewhere on the same screen:
 *
 *     credited + pending === total won revenue in the period
 */

/** `deals.approval_status` values that earn quota credit. */
export const QUOTA_CREDIT_APPROVAL_STATUSES = ['none', 'approved'] as const;

/**
 * `deals.approval_status` values that hold revenue back from quota
 * while still being genuinely won. Only these produce a footnote.
 */
export const QUOTA_WITHHELD_APPROVAL_STATUSES = ['pending', 'rejected'] as const;

/**
 * SQL fragment (bare, no `WHERE`) matching the credited statuses.
 * Inlined as a literal rather than a bound parameter because the
 * values are a compile-time constant — there is no user input here to
 * parameterise, and `IN (${sql.join(...)})` on an enum column defeats
 * the index in a way a literal list does not.
 *
 * Callers combine it with their own `stage = 'won'` / tenant / window
 * predicates; this fragment deliberately does NOT include those, so it
 * can't smuggle a scope decision into a query that already made one.
 */
export const QUOTA_CREDIT_SQL = `approval_status IN (${QUOTA_CREDIT_APPROVAL_STATUSES.map(
  (s) => `'${s}'`,
).join(', ')})`;

/** The complement of {@link QUOTA_CREDIT_SQL}, for the pending footnote. */
export const QUOTA_WITHHELD_SQL = `approval_status IN (${QUOTA_WITHHELD_APPROVAL_STATUSES.map(
  (s) => `'${s}'`,
).join(', ')})`;

/** Same rule, for rows already loaded into app memory. */
export function earnsQuotaCredit(approvalStatus: string | null): boolean {
  return (QUOTA_CREDIT_APPROVAL_STATUSES as readonly string[]).includes(
    approvalStatus ?? 'none',
  );
}

/**
 * The one-line disclosure a tile renders when won revenue is sitting
 * behind the approval gate. Returns null when nothing is withheld —
 * the overwhelmingly common case, and the tile should stay quiet then
 * rather than reassure the user about a rule they never hit.
 *
 * `formatMoney` is injected so this stays currency-context-free.
 */
export function pendingApprovalNote(
  pendingMinor: number,
  pendingCount: number,
  formatMoney: (minor: number) => string,
): string | null {
  if (pendingCount <= 0 || pendingMinor <= 0) return null;
  return `${formatMoney(pendingMinor)} from ${pendingCount} won ${
    pendingCount === 1 ? 'deal' : 'deals'
  } awaiting approval — not counted`;
}
