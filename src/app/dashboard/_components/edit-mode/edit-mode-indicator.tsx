'use client';

import { Plus, Settings2, X } from 'lucide-react';

import { cn } from '@/lib/utils';

import { useEditMode } from './edit-mode-context';

/**
 * Floating bottom-right pill that surfaces ONLY when Edit Mode is on.
 * The pill is the single visible signal that the dashboard is in
 * edit mode (no permanent gear, no "Edit dashboard" button in normal
 * view). Doubles as the exit affordance for users who don't know the
 * keyboard shortcut.
 *
 * The "Add widget" button is a placeholder for the next phase
 * (Cmd/Ctrl+Space → Widget Builder). It's intentionally enabled so
 * the affordance is discoverable; clicking it currently no-ops with
 * a tooltip explaining what's coming.
 */
export function EditModeIndicator() {
  const { editMode, exit } = useEditMode();

  return (
    <div
      aria-hidden={!editMode}
      className={cn(
        'pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 transition-all duration-200',
        editMode ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
      )}
    >
      <div
        role="status"
        className={cn(
          'flex items-center gap-1 rounded-full border border-indigo-300/80 bg-white/95 px-2 py-1 shadow-[0_12px_28px_-12px_rgba(99,102,241,0.45)] backdrop-blur-md dark:border-indigo-500/40 dark:bg-[#0A0A0A]/95',
          editMode && 'pointer-events-auto',
        )}
      >
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200">
          <Settings2 className="h-3 w-3" aria-hidden />
          Edit mode
        </div>
        <span className="text-[10px] text-slate-400 dark:text-[#71717A]">·</span>
        <button
          type="button"
          disabled
          title="Widget Builder coming in the next phase"
          aria-label="Add widget (coming soon)"
          className="inline-flex cursor-not-allowed items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-slate-500 opacity-60 dark:text-[#A1A1AA]"
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add widget
        </button>
        <span className="text-[10px] text-slate-400 dark:text-[#71717A]">·</span>
        <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[9.5px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          ⌘⇧E
        </kbd>
        <button
          type="button"
          onClick={exit}
          aria-label="Exit edit mode"
          className="ml-0.5 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * Subtle dotted grid overlay that fades in when edit mode is on,
 * making the layout-canvas feel of the page legible. Pointer-events
 * stay off so the overlay never interferes with widget interaction.
 */
export function EditModeGridOverlay() {
  const { editMode } = useEditMode();
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-0 transition-opacity duration-200',
        editMode ? 'opacity-100' : 'opacity-0',
      )}
      style={{
        backgroundImage:
          'radial-gradient(rgba(99,102,241,0.18) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0',
      }}
    />
  );
}
