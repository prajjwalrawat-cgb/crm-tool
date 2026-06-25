import { auth } from '@/lib/auth/server';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { aiModeLabel } from '@/lib/ai/config';
import {
  type CopilotMessage,
  prepareCopilotPrompt,
} from '@/lib/ai/copilot';
import { streamComplete } from '@/lib/ai/complete';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import {
  adjustGauge,
  captureError,
  currentTraceId,
  incr,
  logger,
  observe,
  runWithTrace,
  withSpan,
} from '@/lib/observability';
import { requireTenant } from '@/lib/tenant';

// Streaming requires the Node runtime — the OpenAI SDK pulls in node-only
// modules and the stream shape we emit holds open a long-lived pipe.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_TURNS = 12;

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_QUESTION_LENGTH),
});

const requestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  history: z.array(messageSchema).max(MAX_HISTORY_TURNS).default([]),
});

/**
 * Streaming Copilot endpoint.
 *
 * Wire protocol — line-delimited JSON, one frame per SSE event:
 *   `event: references` + `data: { references: [...] }`  (one frame, before tokens)
 *   `event: token` + `data: { delta: string }`            (zero or more)
 *   `event: done` + `data: { ok: true }`                  (one frame on success)
 *   `event: error` + `data: { message: string }`          (terminal on failure)
 *
 * Auth: every request goes through Clerk + the active tenant. The retrieval
 * + chat completion runs inside `runWithTenantContext` so RLS scopes the
 * embedding search to the user's own tenant — there is no path to feed
 * cross-tenant records into the prompt.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return await runWithTrace(
    { origin: 'http', name: 'ai.chat' },
    () => handleChat(request),
  );
}

async function handleChat(request: NextRequest): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    incr('ai.chat.unauthenticated');
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const tenant = await requireTenant().catch(() => null);
  if (!tenant) {
    incr('ai.chat.no_tenant');
    return new NextResponse('No active tenant', { status: 403 });
  }

  let parsed: z.infer<typeof requestSchema>;
  try {
    const body = await request.json();
    parsed = requestSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid request body';
    captureError(err, {
      category: 'ai.chat.bad_request',
      severity: 'low',
      retryable: false,
      fields: { tenantId: tenant.id, userId },
    });
    return NextResponse.json({ message }, { status: 400 });
  }

  const history: CopilotMessage[] = parsed.history;

  // Confirm membership before we spend tokens. `requireMembership` self-
  // establishes its own tenant context if none is set, so this is safe to
  // call outside the retrieval context.
  try {
    await requireMembership();
  } catch (err) {
    captureError(err, {
      category: 'ai.chat.forbidden',
      severity: 'medium',
      fields: { tenantId: tenant.id, userId },
    });
    return new NextResponse('Forbidden', { status: 403 });
  }

  incr('ai.chat.request', 1, { mode: aiModeLabel() });
  logger.info('ai.chat starting', {
    tenantId: tenant.id,
    mode: aiModeLabel(),
    questionChars: parsed.question.length,
    historyTurns: history.length,
  });

  const encoder = new TextEncoder();
  const traceId = currentTraceId();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Already closed.
        }
      };

      const send = (event: string, data: unknown) => {
        safeEnqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Bail early if the client navigates away mid-stream.
      request.signal.addEventListener('abort', () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      const startedAt = Date.now();
      adjustGauge('ai.chat.in_flight', 1);

      try {
        await runWithTenantContext(
          { tenantId: tenant.id, userId },
          async () => {
            const { references, messages } = await withSpan(
              'ai.chat.retrieve',
              () =>
                prepareCopilotPrompt({
                  tenantId: tenant.id,
                  actorUserId: userId,
                  history,
                  question: parsed.question,
                }),
            );

            observe('ai.chat.retrieved_records', references.length);

            // Send the trace id alongside the first frame — anyone reading
            // browser devtools can copy it back into a /ops query.
            send('references', { references, traceId });

            const generator = streamComplete({
              tenantId: tenant.id,
              actorUserId: userId,
              messages,
              metadata: {
                question: parsed.question,
                referenceCount: references.length,
                traceId,
              },
            });

            let tokensSent = 0;
            for await (const delta of generator) {
              if (closed) break;
              send('token', { delta });
              tokensSent += 1;
            }
            observe('ai.chat.token_chunks', tokensSent);

            send('done', { ok: true });
          },
        );
        incr('ai.chat.success', 1, { mode: aiModeLabel() });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        captureError(err, {
          category: 'ai.chat.stream',
          severity: 'high',
          retryable: false,
          fields: { tenantId: tenant.id, userId, mode: aiModeLabel() },
        });
        incr('ai.chat.failure', 1, { mode: aiModeLabel() });
        send('error', { message });
      } finally {
        observe('ai.chat.duration_ms', Date.now() - startedAt);
        adjustGauge('ai.chat.in_flight', -1);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
