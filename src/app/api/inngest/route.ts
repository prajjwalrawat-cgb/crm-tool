import { serve } from 'inngest/next';

import { inngest } from '@/lib/inngest/client';
import {
  communicationAnalyticsRollup,
  dealLost,
  dealWon,
  dealHealthRecompute,
  dealScoresNightly,
  newMemberOnboarding,
  notificationsRetention,
  regenerateEmbedding,
  relationshipSignalsDerive,
  staleDealsScan,
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
    dealScoresNightly,
    newMemberOnboarding,
    notificationsRetention,
    regenerateEmbedding,
    relationshipSignalsDerive,
    staleDealsScan,
    workflowRunsRetention,
  ],
});
