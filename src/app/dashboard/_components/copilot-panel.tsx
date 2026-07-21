'use client';

import { AlertTriangle, Loader2, Send, Sparkles, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { CopilotLauncher } from './copilot-launcher';
import { useEditMode } from './edit-mode/edit-mode-context';

type AIMode = 'live' | 'mock' | 'disabled';

type Reference = {
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  label: string;
  distance: number;
};

type ChatTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: Reference[];
  /** True while tokens are still streaming into this assistant turn. */
  streaming?: boolean;
  /** Set when streaming finishes with an error. */
  error?: string;
};

const SUGGESTIONS = [
  'Which deals are most likely to close this month?',
  'Show contacts I haven’t talked to recently.',
  'What’s the state of my Acme deal?',
  'Which deals are stuck in negotiation?',
];

const MAX_HISTORY_TURNS = 12;

/**
 * Floating CRM copilot. Cmd/Ctrl-K to open, Esc to close.
 *
 * Streaming protocol matches `/api/ai/chat`:
 *   - `event: references` arrives once before tokens, with the hydrated
 *     citations the LLM was asked to ground in.
 *   - `event: token` arrives N times with `{ delta }`.
 *   - `event: done` is the terminal success frame; `event: error` is the
 *     terminal failure frame.
 */
export function CopilotPanel({ aiMode }: { aiMode: AIMode }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-hide while any editing surface is active — Chart Studio open,
  // Dashboard Edit Mode on, or (future) Widget Builder open. The
  // copilot's floating launcher overlaps chart controls and breaks
  // immersion during editing, so we collapse it entirely (visual
  // fade + pointer-events:none + force-close if already open).
  const { anyEditingActive } = useEditMode();
  useEffect(() => {
    if (anyEditingActive && open) setOpen(false);
  }, [anyEditingActive, open]);

  // Cmd/Ctrl-K toggles the panel. Esc closes it. Disabled entirely
  // while any editing surface is active so ⌘K can't pop the copilot
  // over an open Chart Studio / Widget Builder / Edit Mode canvas.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (anyEditingActive) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, anyEditingActive]);

  // Focus input when opening.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Cancel in-flight stream on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const history = useMemo(
    () =>
      turns
        // Drop in-flight assistant turn — it isn't part of the prior
        // conversation yet.
        .filter((t) => !t.streaming && !t.error)
        .slice(-MAX_HISTORY_TURNS)
        .map((t) => ({ role: t.role, content: t.content })),
    [turns],
  );

  const sendQuestion = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || streaming) return;

      const userTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
      };
      const assistantTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        streaming: true,
      };
      setTurns((t) => [...t, userTurn, assistantTurn]);
      setInput('');
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, history }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Copilot request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE frames: each ends with "\n\n".
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);

            const eventLine = frame
              .split('\n')
              .find((l) => l.startsWith('event:'));
            const dataLine = frame
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice('event:'.length).trim();
            const dataRaw = dataLine.slice('data:'.length).trim();
            let payload: unknown;
            try {
              payload = JSON.parse(dataRaw);
            } catch {
              continue;
            }

            if (event === 'references') {
              const data = payload as { references: Reference[] };
              setTurns((t) =>
                t.map((turn) =>
                  turn.id === assistantTurn.id
                    ? { ...turn, references: data.references }
                    : turn,
                ),
              );
            } else if (event === 'token') {
              const data = payload as { delta: string };
              setTurns((t) =>
                t.map((turn) =>
                  turn.id === assistantTurn.id
                    ? { ...turn, content: turn.content + data.delta }
                    : turn,
                ),
              );
            } else if (event === 'done') {
              setTurns((t) =>
                t.map((turn) =>
                  turn.id === assistantTurn.id
                    ? { ...turn, streaming: false }
                    : turn,
                ),
              );
              break outer;
            } else if (event === 'error') {
              const data = payload as { message: string };
              setTurns((t) =>
                t.map((turn) =>
                  turn.id === assistantTurn.id
                    ? {
                        ...turn,
                        streaming: false,
                        error: data.message,
                      }
                    : turn,
                ),
              );
              break outer;
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Copilot failed';
        setTurns((t) =>
          t.map((turn) =>
            turn.id === assistantTurn.id
              ? { ...turn, streaming: false, error: message }
              : turn,
          ),
        );
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [history, streaming],
  );

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <>
      <CopilotLauncher onOpen={() => setOpen(true)} hidden={anyEditingActive} />

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="CRM Copilot"
        >
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div
            className={cn(
              'relative flex h-full w-full max-w-md flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl',
              'sm:h-[80vh] sm:rounded-xl',
              '',
            )}
          >
            <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-amber-500" aria-hidden />
                CRM Copilot
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close Copilot"
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </header>

            {aiMode === 'disabled' ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden />
                <span>
                  AI is enabled but a provider key is missing — answers may be
                  limited until it&apos;s configured.
                </span>
              </div>
            ) : null}

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
              {turns.length === 0 ? (
                <EmptyState onPick={(q) => sendQuestion(q)} />
              ) : (
                <ul className="flex flex-col gap-4">
                  {turns.map((turn) => (
                    <Turn key={turn.id} turn={turn} />
                  ))}
                </ul>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendQuestion(input);
              }}
              className="border-t border-slate-200 p-3"
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendQuestion(input);
                    }
                  }}
                  rows={2}
                  placeholder="Ask about your pipeline…"
                  className="block w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                {streaming ? (
                  <button
                    type="button"
                    onClick={stop}
                    aria-label="Stop generating"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Send"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Grounded in your tenant&apos;s records only. Press{' '}
                <kbd className="rounded border border-slate-300 px-1 py-0.5 text-[10px]">
                  Esc
                </kbd>{' '}
                to close.
              </p>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">
        Ask a question about your pipeline. The Copilot reads only your
        tenant&apos;s deals, contacts, and companies.
      </p>
      <ul className="flex flex-col gap-2">
        {SUGGESTIONS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white shadow-sm">
          {turn.content}
        </div>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2">
      {turn.references && turn.references.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {turn.references.map((ref) => (
            <span
              key={`${ref.entityType}:${ref.entityId}`}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600"
              title={`distance ${ref.distance.toFixed(3)}`}
            >
              <span className="font-medium uppercase tracking-wide text-[9px] text-slate-400">
                {ref.entityType}
              </span>
              {ref.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm leading-relaxed text-slate-800">
        {turn.error ? (
          <span className="text-red-600">
            Error: {turn.error}
          </span>
        ) : turn.content ? (
          <p className="whitespace-pre-wrap">{turn.content}</p>
        ) : (
          <span className="inline-flex items-center gap-2 text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Thinking…
          </span>
        )}
        {turn.streaming && turn.content ? (
          <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-slate-400 align-baseline" />
        ) : null}
      </div>
    </li>
  );
}
