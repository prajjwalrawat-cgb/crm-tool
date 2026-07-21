'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * The single, shared Copilot launcher button — one component used everywhere
 * (rendered once, globally, by CopilotPanel) so the icon, label, and keyboard
 * shortcut hint are identical on every screen. The shortcut hint is
 * platform-aware (⌘K on macOS, Ctrl K elsewhere), computed after mount so the
 * SSR markup doesn't commit a wrong guess — matching the command-palette hint
 * in the header.
 */
export function CopilotLauncher({
  onOpen,
  hidden,
}: {
  onOpen: () => void;
  /** Fade the launcher out of the way while an editing surface is active. */
  hidden: boolean;
}) {
  const [shortcut, setShortcut] = useState('⌘K');
  useEffect(() => {
    setShortcut(
      typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
        ? '⌘K'
        : 'Ctrl K',
    );
  }, []);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open Copilot (${shortcut})`}
      aria-hidden={hidden}
      title={`Open Copilot (${shortcut})`}
      className={cn(
        'fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-indigo-200 hover:bg-indigo-50/60 hover:text-indigo-700',
        // Smooth fade + slight downward motion when any editing surface is
        // active so the launcher gets out of the way.
        hidden
          ? 'pointer-events-none translate-y-3 opacity-0'
          : 'translate-y-0 opacity-100',
      )}
      tabIndex={hidden ? -1 : 0}
    >
      <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
      <span>Copilot</span>
      <kbd className="ml-0.5 hidden rounded border border-slate-200 bg-slate-50 px-1 py-0 text-[9px] font-medium text-slate-500 sm:inline">
        {shortcut}
      </kbd>
    </button>
  );
}
