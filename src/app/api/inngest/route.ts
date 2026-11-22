import { serve } from 'inngest/next';

import { inngest } from '@/lib/inngest/client';
import {
  communicationAnalyticsRollup,
  dealLost,
  dealWon,
  dealHealthRecompute,
  dealRiskNightly,
  dealScoresNightly,
  forecastSnapshotWeekly,
  gmailSync,
  holdRevisitDaily,
  prospectMaintenanceDaily,
  incentiveActualsNightly,
  callAiSummarize,
  callTranscribe,
  suggestionsFromCall,
  suggestionsFromEmail,
  callEventProcess,
  callRecordingArchive,
  campaignDialerTick,
  leadDistribute,
  leadImportProcess,
  leadIngestProcess,
  leadSlaWatchdog,
  leadUnassignedRetry,
  newMemberOnboarding,
  notificationsRetention,
  regenerateEmbedding,
  relationshipSignalsDerive,
  reportBackfill,
  reportDigestsHourly,
  reportRollupNightly,
  reportRollupRecent,
  staleDealsScan,
  teamMetricsMonthly,
  workflowRunsRetention,
} from '@/lib/inngest/workflows';

/**
 * Inngest serve endpoint. The Inngest cloud (or local dev server)
 * authenticates incoming requests via signed headers and invokes our
 * registered functions. Auth is handled by Inngest's signature
 * verification — we exempt this route from Clerk middleware below.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    communicationAnalyticsRollup,
    dealLost,
    dealWon,
    dealHealthRecompute,
    dealRiskNightly,
  dealScoresNightly,
    forecastSnapshotWeekly,
    gmailSync,
    holdRevisitDaily,
    prospectMaintenanceDaily,
    incentiveActualsNightly,
    callAiSummarize,
    callTranscribe,
    suggestionsFromCall,
    suggestionsFromEmail,
    callEventProcess,
    callRecordingArchive,
    campaignDialerTick,
    leadDistribute,
    leadImportProcess,
    leadIngestProcess,
    leadSlaWatchdog,
    leadUnassignedRetry,
    newMemberOnboarding,
    notificationsRetention,
    regenerateEmbedding,
    relationshipSignalsDerive,
    reportBackfill,
    reportDigestsHourly,
    reportRollupNightly,
    reportRollupRecent,
    staleDealsScan,
    teamMetricsMonthly,
    workflowRunsRetention,
  ],
});

/** Transcription steps can take a few minutes (Sarvam batch polling); allow up to 5 min per step. */
export const maxDuration = 300;
