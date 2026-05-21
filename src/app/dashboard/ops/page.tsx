import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import {
  getAiInvocationStats,
  getEmailDeliveryStats,
  getRecentAiInvocations,
  getRecentWorkflowRuns,
  getWorkflowStats,
} from '@/lib/ops/queries';
import {
  getSenderIdentity,
  readNodemailerConfig,
} from '@/lib/email/providers/factory';
import { validateEnv } from '@/lib/env';
import { recentErrors, recentLogs, snapshotMetrics } from '@/lib/observability';
import { requirePersonas } from '@/lib/personas/guards';

import { AiSection } from './_components/ai-section';
import { AutomationHealthSection } from './_components/automation-health-section';
import {
  EmailProviderSection,
  type EmailProviderStatus,
} from './_components/email-provider-section';
import { EmailSection } from './_components/email-section';
import { ErrorsSection } from './_components/errors-section';
import { LatencySection } from './_components/latency-section';
import { LogsSection } from './_components/logs-section';
import { OverviewSection } from './_components/overview-section';
import { RealtimeSection } from './_components/realtime-section';
import { WorkflowsSection } from './_components/workflows-section';

export const metadata = { title: 'Operations' };

// In-memory metrics + recent logs + recent errors live on the Node
// process. The page must always re-read them; cache it and the surface
// turns into a stale snapshot.
export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [aiStats, recentAi, runStats, recentRuns, emailStats] =
      await Promise.all([
        getAiInvocationStats(tenant.id, 24),
        getRecentAiInvocations(tenant.id),
        getWorkflowStats(tenant.id, 24),
        getRecentWorkflowRuns(tenant.id),
        getEmailDeliveryStats(tenant.id, 24),
      ]);

    const metrics = snapshotMetrics();
    const errors = recentErrors.recent(50);
    const logs = recentLogs.recent(50);
    const aiMode = getAIMode();
    const emailProviderStatus = readEmailProviderStatus();

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Operations</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Live platform health for this tenant. Counters, gauges, and
            histograms are read from the current Node process; recent
            workflow + AI rows come from Postgres.
          </p>
        </header>

        <div className="grid gap-6">
          <OverviewSection
            aiMode={aiMode}
            aiStats={aiStats}
            runStats={runStats}
            metrics={metrics}
          />
          <AutomationHealthSection
            errors={errors}
            runStats={runStats}
            emailStats={emailStats}
          />
          <AiSection mode={aiMode} stats={aiStats} recent={recentAi} metrics={metrics} />
          <WorkflowsSection stats={runStats} recent={recentRuns} metrics={metrics} />
          <EmailProviderSection status={emailProviderStatus} />
          <EmailSection stats={emailStats} />
          <RealtimeSection metrics={metrics} />
          <LatencySection metrics={metrics} />
          <ErrorsSection errors={errors} />
          <LogsSection logs={logs} />
        </div>
      </main>
    );
  });
}

/**
 * Collect a non-credential snapshot of the email provider config for
 * the ops page. Never reads / surfaces SMTP_PASSWORD or RESEND_API_KEY
 * directly — only their presence + the username masked to local-part
 * prefix + domain.
 */
function readEmailProviderStatus(): EmailProviderStatus {
  const raw = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();
  const provider: EmailProviderStatus['provider'] =
    raw === 'nodemailer' || raw === 'resend' ? raw : 'console';

  const senderIdentity = getSenderIdentity();
  const envResult = validateEnv();
  // Filter warnings to the email surface so this card doesn't
  // duplicate unrelated warnings (e.g. CLERK_WEBHOOK_*) shown elsewhere.
  const warnings = envResult.warnings.filter(
    (w) =>
      w.includes('EMAIL_PROVIDER') ||
      w.includes('EMAIL_FROM') ||
      w.includes('SMTP_') ||
      w.includes('RESEND_API_KEY'),
  );

  const smtpCfg = readNodemailerConfig();
  return {
    provider,
    senderIdentity,
    smtp:
      provider === 'nodemailer' && smtpCfg
        ? {
            host: smtpCfg.host,
            port: smtpCfg.port,
            secure: smtpCfg.secure,
            userMasked: maskUser(smtpCfg.user),
          }
        : undefined,
    resendKeyPresent:
      provider === 'resend' ? Boolean(process.env.RESEND_API_KEY) : undefined,
    warnings,
  };
}

function maskUser(user: string): string {
  if (!user.includes('@')) return user.slice(0, 3) + '***';
  const [local, domain] = user.split('@', 2);
  if (!local || !domain) return '***';
  return `${local.slice(0, 3)}***@${domain}`;
}
