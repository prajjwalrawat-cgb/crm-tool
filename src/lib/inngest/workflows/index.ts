/**
 * Inngest function registry. Add new workflows here so the serve handler
 * can register them — keeping the list in one place avoids the "function
 * exists but isn't reachable" failure mode of forgotten imports.
 *
 * Each workflow file ALSO exports a plain handler function (e.g.
 * `dealWonHandler`) that the in-process local dispatcher can invoke
 * when Inngest is unreachable in dev. Both paths share the same body.
 */
import { registerLocalHandler } from '../local-dispatcher';

import { communicationAnalyticsRollup } from './communication-analytics-rollup';
import { dealLost, dealLostHandler } from './deal-lost';
import { dealWon, dealWonHandler } from './deal-won';
import {
  dealHealthRecompute,
  dealHealthRecomputeHandler,
} from './deal-health-recompute';
import { dealScoresNightly } from './deal-scores-nightly';
import { forecastSnapshotWeekly } from './forecast-snapshot-weekly';
import { gmailSync } from './gmail-sync';
import { holdRevisitDaily } from './hold-revisit-daily';
import {
  newMemberOnboarding,
  newMemberOnboardingHandler,
} from './new-member-onboarding';
import {
  regenerateEmbedding,
  regenerateEmbeddingHandler,
} from './regenerate-embedding';
import { notificationsRetention } from './notifications-retention';
import { relationshipSignalsDerive } from './relationship-signals-derive';
import { staleDealsScan } from './stale-deals-scan';
import { teamMetricsMonthly } from './team-metrics-monthly';
import { workflowRunsRetention } from './workflow-runs-retention';

// Register the handlers eagerly at module load. Server-component pages
// already import from this module on first render so registration runs
// well before any send/dispatch. Multiple handlers can subscribe to the
// same event — `crm/deal.stage_changed` fans out to both deal-won and
// deal-lost; each filters by `to` stage in its body.
registerLocalHandler('crm/deal.stage_changed', dealWonHandler);
registerLocalHandler('crm/deal.stage_changed', dealLostHandler);
registerLocalHandler('crm/ai.embed_entity', regenerateEmbeddingHandler);
registerLocalHandler('crm/member.invited', newMemberOnboardingHandler);
registerLocalHandler('crm/deal.health_recompute', dealHealthRecomputeHandler);

export {
  communicationAnalyticsRollup,
  dealLost,
  dealWon,
  dealHealthRecompute,
  dealScoresNightly,
  forecastSnapshotWeekly,
  gmailSync,
  holdRevisitDaily,
  newMemberOnboarding,
  notificationsRetention,
  regenerateEmbedding,
  relationshipSignalsDerive,
  staleDealsScan,
  teamMetricsMonthly,
  workflowRunsRetention,
};
