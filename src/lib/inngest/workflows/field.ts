import { cron } from 'inngest';

import { scanTenantRisks, tenantsWithMeetingsInWindow } from '@/lib/field/risk-scan';

import { inngest } from '../client';
import { eachTenant } from './each-tenant';

/**
 * Field Meetings risk scan, every 5 minutes. One step for all tenants (Inngest bills per
 * step). Persists at_risk_reasons and notifies the rep and manager once per new flag.
 * Tenants outside their tracking hours are skipped inside scanTenantRisks.
 */
export const fieldRiskScan = inngest.createFunction(
  {
    id: 'field-risk-scan',
    name: 'Field — meeting risk scan',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [cron('*/5 * * * *')],
  },
  async ({ step }) =>
    step.run('scan', async () => {
      const tenantIds = await tenantsWithMeetingsInWindow(new Date());
      return eachTenant(tenantIds, 'field-risk-scan', (tenantId) => scanTenantRisks(tenantId));
    }),
);
