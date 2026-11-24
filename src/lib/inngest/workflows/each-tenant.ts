import { captureError } from '@/lib/observability';

/**
 * Run `fn` for every tenant, sequentially, inside the caller's single
 * `step.run`. Inngest bills every step as an execution, so a cron that opens
 * one step per tenant costs (1 + tenants) executions per run; on frequent
 * crons that alone exhausted the plan. Use this only for quick, idempotent DB
 * work: anything slow or network-bound (mail sync, sending digests) keeps its
 * own step so it gets its own timeout and retry.
 *
 * One tenant failing does not stop the others. Failures are reported and
 * listed, not rethrown: rethrowing would make Inngest retry the whole step
 * (every tenant again, billed again), and the next cron run retries anyway.
 */
export async function eachTenant<T>(
  tenantIds: readonly string[],
  category: string,
  fn: (tenantId: string) => Promise<T>,
  onError: (err: unknown, tenantId: string) => void = (err, tenantId) =>
    captureError(err, { category, severity: 'medium', fields: { tenantId } }),
): Promise<{ ok: Record<string, T>; failed: string[] }> {
  const ok: Record<string, T> = {};
  const failed: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      ok[tenantId] = await fn(tenantId);
    } catch (err) {
      failed.push(tenantId);
      onError(err, tenantId);
    }
  }
  return { ok, failed };
}
